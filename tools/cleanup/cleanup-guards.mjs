/**
 * cleanup-guards.mjs — the checks that must pass before cleanup deletes anything
 *
 * What:    Each guard returns { id, status: 'pass'|'fail'|'skip', detail }. Cleanup refuses (status
 *          'refused', exit 2) when any guard fails:
 *          not-prod · allow-cleanup (safety.allowCleanup) · run-id-unique (the run id is not a prefix of another
 *          run id in results/) · database-name · disk-results / disk-data-stores (≥ MIN_FREE_DISK_GB) ·
 *          slot-health (no lost/unreserved slot, safe_wal_size ≥ CLEANUP_MIN_SAFE_WAL_GB) ·
 *          due-transitions (no unprocessed transition of THIS run due now or within IDLE_TIMEOUT: Step SLA
 *          would judge those steps — and write deviation rows — while we delete them; a Step SLA run's
 *          alarms ring spread over the whole test, so an aborted run still has alarms to come. Later rings,
 *          e.g. the day-long SLA deadlines a matcher run creates, are reported, not refused: if one rings
 *          mid-cleanup, cleanup.mjs re-stages the new child rows on the foreign-key error and retries) ·
 *          matcher-idle (local: consumer-group lag 0; dev/uat, where real
 *          traffic keeps lag above 0: no new rows for this run's selectors over IDLE_FLAT_DURATION) ·
 *          confirmation (typed "yes" unless --yes).
 * How:     Imported by tools/cleanup/cleanup.mjs.
 * Needs:   A `query(sql) → rows` on the cleanup's ONE dedicated client, injected kafkaAdmin/statfs/exec/sleep.
 * Outputs: Guard objects.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  freeGbAt,
  measureDataStores,
  minFreeDiskGb,
  readSlots,
  settingValues,
  slotProblems,
} from '../preflight/probes.mjs';
import { buildActivitySql } from './cleanup-tables.mjs';

/** Builders. Why: one shape for the JSON's guards[] and the printed list. */
const ok = (id, detail) => ({ id, status: 'pass', detail });
const no = (id, detail) => ({ id, status: 'fail', detail });

/**
 * Unprocessed transitions ("alarms") of the staged steps (needs lt_si staged): `n` = due now or within
 * `soonSeconds` (refused), `due_now` = already due, `later` = ringing after that, `last_soon` = the last
 * ring time inside the window (when to try again).
 * Why the window: Step SLA picks a row up as soon as next_attempt_at passes and, in the same transaction,
 * writes deviation rows that point at step_instance. A row ringing during the cleanup would add children
 * after they were staged.
 * @param {number} [soonSeconds] IDLE_TIMEOUT (default 300): with --wait the guard re-checks that long
 */
export function dueTransitionsSql(soonSeconds = 300) {
  const soon = `now() + interval '${Math.max(0, Math.round(Number(soonSeconds) || 0))} seconds'`;
  return (
    `SELECT count(*) FILTER (WHERE t.next_attempt_at <= ${soon})::bigint AS n, ` +
    'count(*) FILTER (WHERE t.next_attempt_at <= now())::bigint AS due_now, ' +
    `count(*) FILTER (WHERE t.next_attempt_at > ${soon})::bigint AS later, ` +
    `max(t.next_attempt_at) FILTER (WHERE t.next_attempt_at <= ${soon}) AS last_soon ` +
    'FROM step_sla_state_transition t JOIN lt_si s ON t.step_instance_id = s.id ' +
    'WHERE NOT t.is_processed'
  );
}

/** The guard query with the default window (IDLE_TIMEOUT 300 s); printCleanupSql uses the run's setting. */
export const DUE_TRANSITIONS_SQL = dueTransitionsSql();

/** Never prod: kind must be local/dev/uat and the name must not look like prod. */
export function guardNotProd(environment) {
  const bad =
    !['local', 'dev', 'uat'].includes(environment?.kind) || /prod/i.test(String(environment?.name));
  return bad
    ? no('not-prod', `environment "${environment?.name}" (${environment?.kind}) is refused`)
    : ok('not-prod', `${environment.name} (${environment.kind})`);
}

/** The environment must allow cleanup explicitly. */
export function guardAllowCleanup(environment) {
  return environment?.safety?.allowCleanup === true
    ? ok('allow-cleanup', 'safety.allowCleanup is true')
    : no(
        'allow-cleanup',
        `safety.allowCleanup is not true in config/environments/${environment?.name}.json`,
      );
}

/**
 * Run ids known from results/: run-context.json `runId`s and default ids at the end of folder names.
 * Why: the belt-and-braces prefix guard needs every run id that exists locally.
 */
export function knownRunIds(resultsRoot) {
  const ids = new Set();
  if (!fs.existsSync(resultsRoot)) return ids;
  for (const entry of fs.readdirSync(resultsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const stamp = /(\d{8}-\d{6})$/.exec(entry.name);
    if (stamp) ids.add(stamp[1]);
    const contextFile = path.join(resultsRoot, entry.name, 'run-context.json');
    if (fs.existsSync(contextFile)) {
      try {
        const runId = JSON.parse(fs.readFileSync(contextFile, 'utf8')).runId;
        if (runId) ids.add(String(runId));
      } catch {
        // A damaged run-context.json is not this guard's concern.
      }
    }
  }
  return ids;
}

/** Refuse a run id for which results/ holds a different run id starting with "<runId>-" (plan §2.3). */
export function guardRunIdUnique({ runId, all }, resultsRoot) {
  if (all) return { id: 'run-id-unique', status: 'skip', detail: '--all' };
  const clash = [...knownRunIds(resultsRoot)].filter(
    (other) => other !== runId && other.startsWith(`${runId}-`),
  );
  return clash.length
    ? no(
        'run-id-unique',
        `run id ${runId} is a prefix of other run id(s) in results/: ${clash.join(', ')}`,
      )
    : ok('run-id-unique', `no other run id starts with ${runId}-`);
}

/** Connected to the database the environment names. */
export async function guardDatabaseName(query, environment) {
  const [row] = await query('SELECT current_database() AS database');
  return row?.database === environment.database?.name
    ? ok('database-name', row.database)
    : no(
        'database-name',
        `connected to "${row?.database}", expected "${environment.database?.name}"`,
      );
}

/**
 * Free disk for results and (local) Docker's data root. Returns the guards and the measured disk block.
 * Why: deleting writes WAL; a full disk mid-delete is worse than not deleting.
 */
export async function guardDisk({ environment, settings, resultsRoot, statfs, exec, query }) {
  const limitGb = minFreeDiskGb(settings, environment);
  const results = await freeGbAt(statfs, resultsRoot);
  const stores = await measureDataStores({ environment, exec, statfs, query });
  const guards = [
    results.freeGb >= limitGb
      ? ok('disk-results', `${results.freeGb} GB free (limit ${limitGb} GB)`)
      : no(
          'disk-results',
          `only ${results.freeGb} GB free at ${results.path} (limit ${limitGb} GB)`,
        ),
  ];
  if (stores.dataStoresSource === 'docker-root') {
    guards.push(
      stores.dataStoresFreeGb >= limitGb
        ? ok(
            'disk-data-stores',
            `${stores.dataStoresFreeGb} GB free at Docker root (limit ${limitGb} GB)`,
          )
        : no(
            'disk-data-stores',
            `only ${stores.dataStoresFreeGb} GB free at Docker root ${stores.path} (limit ${limitGb} GB)`,
          ),
    );
  } else
    guards.push({
      id: 'disk-data-stores',
      status: 'skip',
      detail: 'remote data stores: not measurable from here',
    });
  const disk = {
    resultsFreeGb: results.freeGb,
    dataStoresFreeGb: stores.dataStoresFreeGb,
    dataStoresSource: stores.dataStoresSource,
    dbSizeBytes: stores.dbSizeBytes,
    walBytes: stores.walBytes,
  };
  return { guards, disk, limitGb };
}

/** Slot health (shared rule with preflight wal-and-slots and the every-10-batches check). */
export async function guardSlots(query, settings) {
  const wal = await readSlots(query);
  const problems = slotProblems(
    wal.slots,
    Number(settingValues(settings).CLEANUP_MIN_SAFE_WAL_GB ?? 2),
  );
  return {
    guard: problems.length
      ? no('slot-health', problems.join('; '))
      : ok('slot-health', `${wal.slots.length} slot(s) healthy`),
    wal,
  };
}

/**
 * "Still processing" guards, scoped to this run's data (plan §7.2). With `wait`, re-checks until
 * IDLE_TIMEOUT. Returns the guards of the last attempt.
 */
export async function guardProcessing({
  query,
  environment,
  settings,
  options,
  kafkaAdmin,
  sleep,
  wait = false,
  now = () => new Date(),
}) {
  const values = settingValues(settings);
  const flatMs = Number(values.IDLE_FLAT_DURATION ?? 30) * 1000;
  const soonSeconds = Number(values.IDLE_TIMEOUT ?? 300);
  const deadline = now().getTime() + soonSeconds * 1000;
  for (;;) {
    const guards = [];
    const [row = {}] = await query(dueTransitionsSql(soonSeconds));
    const due = Number(row.n ?? 0);
    const later = Number(row.later ?? 0);
    const laterText = later
      ? `; ${later} more ring later than ${soonSeconds} s from now (not refused: they are deleted with the run)`
      : '';
    const lastSoon = row.last_soon ? new Date(row.last_soon).toISOString() : null;
    guards.push(
      due > 0
        ? no(
            'due-transitions',
            `${due} unprocessed transition(s) of this run are due now or within ${soonSeconds} s` +
              `${row.due_now !== undefined ? ` (${Number(row.due_now)} already due)` : ''}: Step SLA is still ` +
              `judging this run and would write deviation rows during the delete; wait until ` +
              `${lastSoon ?? 'they are processed'} (or use --wait)${laterText}`,
          )
        : ok(
            'due-transitions',
            `no unprocessed transition of this run due within ${soonSeconds} s${laterText}`,
          ),
    );
    if (environment.kind === 'local') {
      // The laptop has no other traffic: any lag means the matcher is still busy (maybe with our events).
      if (!kafkaAdmin)
        guards.push(no('matcher-idle', 'no Kafka admin client to read the matcher lag'));
      else {
        const lag = await kafkaAdmin.getGroupLag({
          groupId: environment.kafka.matcherConsumerGroup,
          topic: environment.kafka.inboundTopic,
        });
        guards.push(
          Number(lag?.total) > 0
            ? no('matcher-idle', `matcher consumer-group lag ${lag.total}`)
            : ok('matcher-idle', 'matcher lag 0'),
        );
      }
    } else {
      // Dev/UAT: real traffic keeps lag above 0, so look at THIS run's rows instead: no growth = idle.
      const sql = buildActivitySql(options, {
        now: now(),
        uuidFloorOfLastHour: options.activityFloor ?? null,
      });
      const [first] = await query(sql);
      await sleep(flatMs);
      const [second] = await query(sql);
      const grew =
        Number(second?.protocol_instance) > Number(first?.protocol_instance) ||
        Number(second?.matcher_event_log) > Number(first?.matcher_event_log);
      guards.push(
        grew
          ? no(
              'matcher-idle',
              `new rows for this run within ${flatMs / 1000} s (protocol_instance ${first?.protocol_instance}→${second?.protocol_instance}, matcher_event_log ${first?.matcher_event_log}→${second?.matcher_event_log})`,
            )
          : ok('matcher-idle', `no new rows for this run within ${flatMs / 1000} s`),
      );
    }
    if (guards.every((g) => g.status !== 'fail') || !wait || now().getTime() >= deadline)
      return guards;
    await sleep(Math.min(flatMs || 5000, 5000)); // --wait: try again until IDLE_TIMEOUT
  }
}
