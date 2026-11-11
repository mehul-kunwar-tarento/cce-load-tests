/**
 * fake-pg.mjs — a fake Postgres connection for cleanup unit tests (records every statement, connects nowhere)
 *
 * What:    Cleanup must run every statement on ONE dedicated connection, in a fixed order. This fake records
 *          the statements in order and simulates just enough of the database to drive runCleanup:
 *          schema detection, staged TEMP lists (lt_*) with row counts, batched deletes that empty those lists,
 *          verification counts, orphans that appear while cleanup runs, lock timeouts, the temporary index's
 *          validity and replication slots that change between reads (e.g. a slot that becomes "lost").
 *          The fake pool hands out that one client; pool.query throws, because cleanup must never use it.
 * How:     import { fakeCleanupDb } from './fake-pg.mjs';
 *          const db = fakeCleanupDb({ counts: { lt_pi: 3 }, orphans: { step_instance_history: 2 } });
 *          await runCleanup({ …, clients: { pgPool: db.pool, … } }); db.statements → every SQL in order
 * Needs:   Nothing (imported by tools/cleanup/unit-tests/*.spec.mjs and tools/commands/unit-tests/cleanup.spec.mjs).
 * Outputs: { pool, client, statements, staged, options } — fakes only.
 */

const GB = 1024 ** 3;

/** Staged rows per list for a small run (3 patients, 1 event each, plan set "emr-service"). */
export const DEFAULT_COUNTS = Object.freeze({
  lt_pi: 3,
  lt_si: 6,
  lt_sgi: 0,
  lt_sih: 9,
  lt_pih: 3,
  lt_iel: 0,
  lt_idl: 0,
  lt_ida: 0,
  lt_dev: 0,
  lt_sst: 6,
  lt_mel: 3,
  lt_in: 3,
  lt_fac: 1,
});

/** Columns per table of the release-2.0.0 schema (no intelligence_delivery tables, no V8 step groups). */
function schemaRows({ stepGroups = false, intelligenceDelivery = false } = {}) {
  const tables = {
    deviation: ['id', 'step_instance_id'],
    step_sla_state_transition: [
      'id',
      'step_instance_id',
      'is_processed',
      'next_attempt_at',
      'process_by',
    ],
    step_instance_history: ['id', 'step_instance_id'],
    intelligence_event_log: ['id', 'protocol_instance_id', 'subject'],
    step_instance: ['id', 'protocol_instance_id', 'matched_event_id'],
    protocol_instance_history: ['id', 'protocol_instance_id'],
    protocol_instance: ['id', 'patient_id'],
    matcher_event_log: ['id', 'cloudevents_id', 'source', 'data'],
    inbound_event_log: ['id', 'cloudevents_id', 'source', 'received_at', 'raw_payload'],
    facility: ['id', 'facility_id'],
  };
  if (stepGroups) {
    tables.step_group_instance = ['id', 'protocol_instance_id'];
    tables.deviation.push('step_group_instance_id');
    tables.step_sla_state_transition.push('step_group_instance_id');
    tables.step_instance.push('step_group_instance_id');
  }
  if (intelligenceDelivery) {
    tables.intelligence_delivery = ['id', 'intelligence_event_id', 'subject'];
    tables.intelligence_delivery_audit_log = ['id', 'intelligence_delivery_id'];
  }
  return Object.entries(tables).flatMap(([table_name, columns]) =>
    columns.map((column_name) => ({ table_name, column_name })),
  );
}

/** A healthy slot. */
export const HEALTHY_SLOT = Object.freeze({
  slot_name: 'cce_analytics_slot',
  active: true,
  wal_status: 'reserved',
  safe_wal_size: 8 * GB,
  lag_bytes: 1024,
});

/**
 * Build the fake database.
 * @param {object} [o]
 * @param {Record<string, number>} [o.counts] rows staged per lt_* list (defaults DEFAULT_COUNTS)
 * @param {Record<string, number>} [o.orphans] table → rows the direct predicate finds after the deletes
 *        (written mid-cleanup); cleared when the orphan round re-stages them
 * @param {Record<string, number>} [o.remaining] table → rows the snapshot still finds after deleting
 * @param {Record<string, number>} [o.lockTimeouts] lt_* list → how many batch attempts fail with lock_timeout
 * @param {Record<string, Error>} [o.failBatch] lt_* list → error thrown by its batch statement
 * @param {Record<string, number>} [o.fkViolations] lt_* list → how many batch attempts fail with a
 *        foreign-key violation (23503: child rows written after staging)
 * @param {(call:number) => object[]} [o.slots] slot rows for the n-th slot read (0-based)
 * @param {Array<object[]>} [o.indexValid] answers of successive indisvalid reads ([] = no index)
 * @param {Error} [o.createIndexError] thrown by CREATE INDEX CONCURRENTLY
 * @param {number} [o.due] unprocessed due transitions of the staged steps
 * @param {Array<{protocol_instance:number, matcher_event_log:number}>} [o.activity] successive dev/uat activity counts
 * @param {string} [o.database] current_database()
 * @param {boolean} [o.stepGroups] V8 step-group table and columns exist
 * @param {boolean} [o.intelligenceDelivery] intelligence_delivery(_audit_log) exist
 */
export function fakeCleanupDb(o = {}) {
  const statements = [];
  const staged = {};
  const counts = { ...DEFAULT_COUNTS, ...(o.counts ?? {}) };
  const orphans = { ...(o.orphans ?? {}) };
  const lockTimeouts = { ...(o.lockTimeouts ?? {}) };
  const fkViolations = { ...(o.fkViolations ?? {}) };
  const indexValid = [...(o.indexValid ?? [[], [{ indisvalid: true }]])];
  const activity = [...(o.activity ?? [])];
  let slotReads = 0;
  let inTransaction = false;
  const transactionLog = [];

  /** Answer one statement. Why: a few regexes are enough to drive runCleanup's control flow. */
  function answer(sql) {
    let m;
    if (sql === 'BEGIN') inTransaction = true;
    if (sql === 'COMMIT' || sql === 'ROLLBACK') inTransaction = false;
    if (/information_schema\.columns/.test(sql)) return schemaRows(o);
    if (/^SELECT current_database\(\) AS database$/.test(sql))
      return [{ database: o.database ?? 'ccedb' }];
    if (/FROM pg_replication_slots/.test(sql))
      return (o.slots ?? (() => [{ ...HEALTHY_SLOT }]))(slotReads++);
    if (/max_slot_wal_keep_size/.test(sql)) return [{ max_slot_wal_keep_size: '10GB' }];
    if (/pg_database_size/.test(sql)) return [{ db_size_bytes: 2 * GB }];
    if (/pg_ls_waldir/.test(sql)) return [{ wal_bytes: 0.5 * GB }];
    if (/^SELECT indisvalid/.test(sql)) return indexValid.length ? indexValid.shift() : [];
    if (/^CREATE INDEX CONCURRENTLY/.test(sql)) {
      transactionLog.push({ sql, inTransaction });
      if (o.createIndexError) throw o.createIndexError;
      return [];
    }
    if (/^DROP INDEX CONCURRENTLY/.test(sql)) {
      transactionLog.push({ sql, inTransaction });
      return [];
    }
    if ((m = /^CREATE TEMP TABLE (lt_\w+) AS SELECT id FROM (lt_\w+)$/.exec(sql))) {
      staged[m[1]] = staged[m[2]] ?? 0; // snapshot copy
      return [];
    }
    if ((m = /CREATE TEMP TABLE (lt_\w+) AS/.exec(sql))) {
      staged[m[1]] = counts[m[1]] ?? 0;
      return [];
    }
    if (/next_attempt_at <= now\(\)/.test(sql)) return [{ n: o.due ?? 0 }];
    if (/AS protocol_instance, /.test(sql))
      return [activity.length ? activity.shift() : { protocol_instance: 3, matcher_event_log: 3 }];
    if ((m = /^SELECT count\(\*\)::bigint AS n FROM (lt_\w+)$/.exec(sql)))
      return [{ n: staged[m[1]] ?? 0 }];
    if (
      (m =
        /^WITH b AS \(DELETE FROM (lt_\w+)(?: WHERE id IN \(SELECT id FROM lt_\w+ LIMIT (\d+)\))? RETURNING id\)/.exec(
          sql,
        ))
    ) {
      const list = m[1];
      if (o.failBatch?.[list]) throw o.failBatch[list];
      if (fkViolations[list] > 0) {
        fkViolations[list] -= 1;
        throw Object.assign(
          new Error('update or delete on table violates foreign key constraint'),
          { code: '23503', constraint: 'deviation_step_instance_id_fkey' },
        );
      }
      if (lockTimeouts[list] > 0) {
        lockTimeouts[list] -= 1;
        throw Object.assign(new Error('canceling statement due to lock timeout'), {
          code: '55P03',
        });
      }
      const take = Math.min(m[2] ? Number(m[2]) : Infinity, staged[list] ?? 0);
      staged[list] = (staged[list] ?? 0) - take;
      return [{ staged: take, deleted: take }];
    }
    if (
      (m =
        /^SELECT count\(\*\)::bigint AS n FROM (\w+) WHERE id IN \(SELECT id FROM (lt_\w+)_all\)$/.exec(
          sql,
        ))
    ) {
      // Rows still staged were never deleted, so they are still in the table; `remaining` adds rows that
      // a delete reported but that are somehow still there.
      return [{ n: (staged[m[2]] ?? 0) + (o.remaining?.[m[1]] ?? 0) }];
    }
    if ((m = /^SELECT count\(\*\)::bigint AS n FROM (\w+) t WHERE /.exec(sql)))
      return [{ n: orphans[m[1]] ?? 0 }];
    if ((m = /^INSERT INTO (lt_\w+) \(.*\) SELECT .* FROM (\w+) t WHERE /.exec(sql))) {
      staged[m[1]] = (staged[m[1]] ?? 0) + (orphans[m[2]] ?? 0);
      orphans[m[2]] = 0; // re-staged: the next batch deletes them
      return [];
    }
    return [];
  }

  const client = {
    released: 0,
    async query(sql, params) {
      statements.push(sql);
      return { rows: answer(sql, params) };
    },
    release() {
      client.released += 1;
    },
  };
  const pool = {
    connects: 0,
    async connect() {
      pool.connects += 1;
      return client;
    },
    async query() {
      throw new Error(
        'pool.query must never be used by cleanup (session state needs one dedicated client)',
      );
    },
  };
  return { pool, client, statements, staged, transactionLog };
}

/** Kafka admin fake for the local matcher-lag guard; `lags` are successive totals. */
export function fakeKafkaAdmin(lags = [0]) {
  const queue = [...lags];
  return {
    getGroupLag: async () => ({
      total: queue.length > 1 ? queue.shift() : queue[0],
      partitions: [],
    }),
  };
}

/** statfs fake: `freeGb` everywhere. */
export function fakeStatfs(freeGb = 100) {
  return async () => ({ bavail: (freeGb * GB) / 4096, bsize: 4096 });
}

/** exec fake answering `docker info`. */
export async function fakeExec(cmd, args) {
  return args[0] === 'info'
    ? { code: 0, stdout: '/var/lib/docker\n', stderr: '' }
    : { code: 1, stdout: '', stderr: '' };
}
