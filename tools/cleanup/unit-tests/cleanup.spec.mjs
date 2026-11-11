/**
 * cleanup.spec.mjs — unit tests of tools/cleanup/cleanup.mjs runCleanup (plan §7.2) on a fake connection
 *
 * What:    Drives runCleanup against fake-pg.mjs and checks the safety promises: every statement on ONE
 *          dedicated client in plan order (pool.query never used), BEGIN / SET LOCAL lock_timeout / COMMIT
 *          around every batch, lock timeouts retried at most 5 times, a foreign-key violation (child rows
 *          written after staging) re-staging the children and retrying at most 3 times, a slot turning "lost" mid-way stops
 *          with 'incomplete', 'verified' only when every after is 0, an orphan written mid-cleanup found by
 *          afterByPredicate and deleted in one extra round, the temporary index (INVALID leftover dropped
 *          first, created with no transaction open, dropped in finally even on errors), the guards
 *          (refused: not allowed, run-id prefix of another run, wrong database, matcher busy on local,
 *          dev/uat rows still growing for this run, due transitions, low disk, unhealthy slot, no "yes"),
 *          dry-run rolling back, the legacy v1 branch only when expected (10-digit v1 ids, never a custom
 *          v2 id), the run's own EVENT_SOURCE and the candidate-id margin in the bounds, the time-zone-safe
 *          bound guessed from a run id without run-context.json, and the cleanup
 *          JSON (§5.6).
 * How:     npm test   (or: node --test tools/cleanup/unit-tests/cleanup.spec.mjs)
 * Needs:   Fakes only; results are written to temporary folders.
 * Outputs: node:test results only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { validateCleanup } from '../../core/result-schema.mjs';
import { resolveSettings } from '../../core/settings.mjs';
import { devEnvironment, localEnvironment } from '../../preflight/unit-tests/fake-clients.mjs';
import {
  CREATE_INDEX_SQL,
  DROP_INDEX_SQL,
  INDEX_VALID_SQL,
  planScope,
  runCleanup,
} from '../cleanup.mjs';
import { CLEANUP_TABLES } from '../cleanup-tables.mjs';
import { HEALTHY_SLOT, fakeCleanupDb, fakeExec, fakeKafkaAdmin, fakeStatfs } from './fake-pg.mjs';

const RUN_ID = '20261105-142233';

/**
 * Run a cleanup on fakes.
 * @param {object} [o] { db: fakeCleanupDb options, environment, set: settings overrides, scope, mode,
 *   lags, freeGb, confirm, resultsRoot, wait }
 */
async function clean(o = {}) {
  const db = fakeCleanupDb(o.db);
  const environment = o.environment ?? localEnvironment();
  const settings = resolveSettings({ environment, overrides: o.set ?? {}, env: {} });
  const resultsRoot = o.resultsRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-results-'));
  const sleeps = [];
  const result = await runCleanup({
    environment,
    scope: o.scope ?? { runId: RUN_ID },
    mode: o.mode ?? 'delete',
    settings,
    clients: {
      pgPool: db.pool,
      kafkaAdmin: fakeKafkaAdmin(o.lags ?? [0]),
      statfs: fakeStatfs(o.freeGb ?? 100),
      exec: fakeExec,
      sleep: async (ms) => sleeps.push(ms),
    },
    confirm: o.confirm ?? (async () => true),
    resultsRoot,
    wait: o.wait ?? false,
    now: () => new Date('2026-11-06T10:00:00Z'),
  });
  return { result, db, sleeps, resultsRoot, statements: db.statements };
}

/** The table a batch statement deletes from. */
const batchTable = (sql) => /d AS \(DELETE FROM (\w+) t USING b/.exec(sql)?.[1] ?? null;
const guard = (result, id) => result.guards.find((g) => g.id === id);

describe('runCleanup — verified path', () => {
  it('runs every statement on ONE dedicated client and never uses pool.query', async () => {
    const { result, db } = await clean();
    assert.equal(result.status, 'verified', result.notes.join('; '));
    assert.equal(db.pool.connects, 1);
    assert.equal(db.client.released, 1);
  });

  it('follows plan order: schema, guards, stage, before counts, batches child-first, verify, ANALYZE, DISCARD TEMP', async () => {
    const { statements } = await clean();
    const first = (re) => statements.findIndex((s) => re.test(s));
    const last = (re) => statements.findLastIndex((s) => re.test(s));
    const order = [
      first(/information_schema\.columns/),
      first(/^CREATE TEMP TABLE lt_pi AS/),
      first(/next_attempt_at <= now\(\)/),
      first(/^SELECT count\(\*\)::bigint AS n FROM lt_/),
      first(/^WITH b AS/),
      last(/^WITH b AS/),
      first(/WHERE id IN \(SELECT id FROM lt_\w+_all\)$/),
      first(/^ANALYZE (?!lt_)/),
      last(/^DISCARD TEMP$/),
    ];
    assert.ok(
      order.every((n) => n >= 0),
      `missing step: ${order}`,
    );
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
      'steps out of order',
    );
    // Child tables first: the order in which tables are first deleted from matches CLEANUP_TABLES.
    const deleted = [...new Set(statements.map(batchTable).filter(Boolean))];
    const expected = CLEANUP_TABLES.map((t) => t.table).filter((t) => deleted.includes(t));
    assert.deepEqual(deleted, expected);
  });

  it('wraps every batch in BEGIN; SET LOCAL lock_timeout; <delete>; COMMIT', async () => {
    const { statements } = await clean({ set: { CLEANUP_LOCK_TIMEOUT: '3s' } });
    statements.forEach((sql, i) => {
      if (!/^WITH b AS/.test(sql)) return;
      assert.equal(statements[i - 2], 'BEGIN');
      assert.equal(statements[i - 1], "SET LOCAL lock_timeout = '3000ms'");
      assert.equal(statements[i + 1], 'COMMIT');
    });
  });

  it('batches by CLEANUP_BATCH_SIZE until the staged list is empty', async () => {
    const { result, statements } = await clean({
      set: { CLEANUP_BATCH_SIZE: '2' },
      db: { counts: { lt_sih: 5 } },
    });
    const sih = result.tables.find((t) => t.table === 'step_instance_history');
    assert.deepEqual([sih.before, sih.deleted, sih.after, sih.batches], [5, 5, 0, 3]);
    assert.ok(
      statements.some((s) =>
        /DELETE FROM lt_sih WHERE id IN \(SELECT id FROM lt_sih LIMIT 2\)/.test(s),
      ),
    );
  });

  it('writes the cleanup JSON (plan §5.6) that validateCleanup accepts, with per-table counts and settings', async () => {
    const { result, resultsRoot } = await clean();
    assert.deepEqual(validateCleanup(result), []);
    assert.equal(
      path.dirname(result.savedTo),
      path.join(
        resultsRoot,
        'cleanup-20261105-142233-' + path.basename(path.dirname(result.savedTo)).slice(-15),
      ),
    );
    const saved = JSON.parse(fs.readFileSync(result.savedTo, 'utf8'));
    assert.match(saved.$comment, /What:.*How:.*Needs:.*Outputs:/);
    assert.equal(saved.tables.length, 13);
    assert.deepEqual(saved.scope.selectors, [
      `LOADTEST-${RUN_ID}-col-`,
      `LOADTEST-${RUN_ID}-mat-`,
      `LOADTEST-${RUN_ID}-sla-`,
    ]);
    assert.equal(saved.settings.CLEANUP_BATCH_SIZE.value, 10000);
    const pi = saved.tables.find((t) => t.table === 'protocol_instance');
    assert.deepEqual(
      [pi.before, pi.deleted, pi.after, pi.afterBySnapshot, pi.afterByPredicate],
      [3, 3, 0, 0, 0],
    );
    const facility = saved.tables.find((t) => t.table === 'facility');
    assert.match(facility.skippedReason, /--all/);
    assert.equal(saved.totals.after, 0);
    assert.ok(saved.analyzed.includes('protocol_instance'));
  });

  it('writes next to the run when its run-context.json is in results/, and uses its bounds', async () => {
    const resultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-run-'));
    const runDir = path.join(resultsRoot, `matcher-smoke-${RUN_ID}`);
    fs.mkdirSync(runDir);
    fs.writeFileSync(
      path.join(runDir, 'run-context.json'),
      JSON.stringify({
        runId: RUN_ID,
        idCode: 'mat',
        startedAt: '2026-11-05T14:22:33.000+05:30',
        dataset: { source: 'loadtest-emr' },
        phasePlan: { phases: [{ plannedEvents: 30 }] },
      }),
    );
    const { result, statements } = await clean({ resultsRoot });
    assert.equal(path.dirname(result.savedTo), runDir);
    assert.match(path.basename(result.savedTo), /^cleanup-\d{8}-\d{6}\.json$/);
    assert.match(result.scope.usedRunContext, /run-context\.json$/);
    const mel = statements.find((s) => s.startsWith('CREATE TEMP TABLE lt_mel AS'));
    assert.match(mel, /generate_series\(0, ph\.cnt - 1\)/, 'candidate ids from the phase plan');
    assert.match(mel, /'loadtest-emr'/);
  });
});

describe('runCleanup — verification and orphans', () => {
  it('catches an orphan written mid-cleanup with afterByPredicate, deletes it in one more round, then verified', async () => {
    const { result, statements } = await clean({ db: { orphans: { step_instance_history: 2 } } });
    assert.equal(result.status, 'verified');
    assert.ok(
      statements.some((s) =>
        /^INSERT INTO lt_sih \(id\) SELECT t\.id FROM step_instance_history t WHERE/.test(s),
      ),
    );
    const sih = result.tables.find((t) => t.table === 'step_instance_history');
    assert.equal(sih.deleted, 9 + 2);
    assert.equal(sih.after, 0);
    assert.ok(result.notes.some((n) => /orphan round: step_instance_history 2/.test(n)));
  });

  it('is incomplete (never verified) when a staged row is still there after deleting', async () => {
    const { result } = await clean({ db: { remaining: { protocol_instance: 1 } } });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.tables.find((t) => t.table === 'protocol_instance').afterBySnapshot, 1);
    assert.deepEqual(validateCleanup(result), []);
  });
});

describe('runCleanup — safety while deleting', () => {
  it('stops with incomplete when a slot turns lost mid-way (checked every 10 batches)', async () => {
    // Read 0 is the start guard; read 1 is the check after 10 batches.
    const slots = (call) =>
      call < 1 ? [{ ...HEALTHY_SLOT }] : [{ ...HEALTHY_SLOT, wal_status: 'lost', active: false }];
    const { result, statements } = await clean({ set: { CLEANUP_BATCH_SIZE: '1' }, db: { slots } });
    assert.equal(result.status, 'incomplete');
    assert.ok(
      result.notes.some((n) => /stopped after 10 batches: slot cce_analytics_slot is lost/.test(n)),
      result.notes.join('\n'),
    );
    assert.equal(
      result.tables.reduce((n, t) => n + t.batches, 0),
      10,
      'exactly 10 batches deleted rows',
    );
    // No delete statement after the slot read that found the lost slot.
    const lostRead = statements.findIndex(
      (s, i) =>
        /FROM pg_replication_slots/.test(s) &&
        i > statements.findIndex((x) => /^WITH b AS/.test(x)),
    );
    assert.ok(lostRead > 0);
    assert.equal(
      statements.slice(lostRead).filter((s) => /^WITH b AS/.test(s)).length,
      0,
      'no batch after the stop',
    );
    // Counts are kept and verification still ran (reads only).
    assert.ok(result.tables.some((t) => t.after > 0));
    assert.deepEqual(validateCleanup(result), []);
  });

  it('retries a lock timeout (ROLLBACK, pause) and succeeds', async () => {
    const { result, statements } = await clean({ db: { lockTimeouts: { lt_pi: 2 } } });
    assert.equal(result.status, 'verified');
    assert.equal(statements.filter((s) => /DELETE FROM lt_pi /.test(s)).length, 3 + 1);
    assert.ok(statements.filter((s) => s === 'ROLLBACK').length >= 2);
  });

  it('gives up after 5 lock timeouts in a row with incomplete', async () => {
    const { result } = await clean({ db: { lockTimeouts: { lt_pi: 5 } } });
    assert.equal(result.status, 'incomplete');
    assert.ok(result.notes.some((n) => /lock timeout 5 times/.test(n)));
  });

  it('foreign-key violation (Step SLA wrote a deviation mid-cleanup): re-stages the children, retries, verified', async () => {
    // An alarm rang after staging: a new deviation points at a staged step, so the step_instance batch
    // fails with 23503 once. The children (deviation …) are re-staged from the snapshots and deleted.
    const { result, statements } = await clean({
      db: { fkViolations: { lt_si: 1 }, orphans: { deviation: 2 } },
    });
    assert.equal(result.status, 'verified', result.notes.join('; '));
    const deviation = result.tables.find((t) => t.table === 'deviation');
    assert.equal(deviation.before, 0);
    assert.equal(deviation.deleted, 2, 'the deviation written after staging is deleted');
    assert.ok(
      result.notes.some((n) =>
        /step_instance: foreign-key violation .*re-staged and deleted .*deviation.*\(1\/3\)/.test(
          n,
        ),
      ),
    );
    // Re-staging happens before the retried step_instance batch.
    const restage = statements.findIndex((x) => /^INSERT INTO lt_dev /.test(x));
    const retried = statements.findLastIndex((x) => /DELETE FROM lt_si /.test(x));
    assert.ok(restage > 0 && restage < retried);
  });

  it('gives up with incomplete when foreign-key violations keep coming', async () => {
    const { result } = await clean({ db: { fkViolations: { lt_si: 10 } } });
    assert.equal(result.status, 'incomplete');
    assert.ok(
      result.notes.some((n) => /foreign-key violation .* 4 times: a service keeps writing/.test(n)),
    );
  });
});

describe('runCleanup — temporary index', () => {
  it('creates it with no transaction open before matcher_event_log and drops it right after', async () => {
    const { result, statements, db } = await clean();
    const create = statements.indexOf(CREATE_INDEX_SQL);
    const firstMel = statements.findIndex((s) => batchTable(s) === 'matcher_event_log');
    const drop = statements.lastIndexOf(DROP_INDEX_SQL);
    const firstInbound = statements.findIndex((s) => batchTable(s) === 'inbound_event_log');
    assert.ok(create >= 0 && create < firstMel && firstMel < drop && drop < firstInbound);
    assert.ok(
      db.transactionLog.every((entry) => entry.inTransaction === false),
      'CONCURRENTLY never inside a transaction',
    );
    assert.deepEqual(result.tempIndex, { used: true, created: true, dropped: true });
  });

  it('drops an INVALID leftover first (IF NOT EXISTS would keep it), then creates and re-checks', async () => {
    const { statements } = await clean({
      db: { indexValid: [[{ indisvalid: false }], [{ indisvalid: true }]] },
    });
    const at = statements.indexOf(INDEX_VALID_SQL);
    assert.deepEqual(statements.slice(at, at + 4), [
      INDEX_VALID_SQL,
      DROP_INDEX_SQL,
      CREATE_INDEX_SQL,
      INDEX_VALID_SQL,
    ]);
  });

  it('drops the index in finally when a batch fails, and when CREATE itself fails half-way', async () => {
    const failed = await clean({ db: { failBatch: { lt_mel: new Error('disk full') } } });
    assert.equal(failed.result.status, 'error');
    assert.equal(failed.result.tempIndex.dropped, true);
    assert.ok(
      failed.statements.indexOf(DROP_INDEX_SQL) > failed.statements.indexOf(CREATE_INDEX_SQL),
    );
    const createFailed = await clean({
      db: { createIndexError: new Error('canceling statement') },
    });
    assert.equal(createFailed.result.status, 'error');
    assert.ok(
      createFailed.statements.indexOf(DROP_INDEX_SQL) >
        createFailed.statements.indexOf(CREATE_INDEX_SQL),
    );
  });

  it('without safety.allowTempIndex: no index, matcher_event_log in batches of 500', async () => {
    const environment = localEnvironment({
      safety: { allowCleanup: true, allowTempIndex: false, minFreeDiskGb: 20 },
    });
    const { result, statements } = await clean({ environment });
    assert.equal(result.status, 'verified');
    assert.ok(!statements.includes(CREATE_INDEX_SQL));
    assert.ok(
      statements.some((s) =>
        /DELETE FROM lt_mel WHERE id IN \(SELECT id FROM lt_mel LIMIT 500\)/.test(s),
      ),
    );
    assert.deepEqual(result.tempIndex, { used: false, created: false, dropped: false });
  });
});

describe('runCleanup — guards (status refused, nothing deleted)', () => {
  /** Assert refused by `id` and that no batch ran. */
  function refusedBy({ result, statements }, id) {
    assert.equal(result.status, 'refused');
    assert.equal(guard(result, id)?.status, 'fail', JSON.stringify(result.guards));
    assert.ok(!statements.some((s) => /^WITH b AS/.test(s)), 'nothing may be deleted');
    assert.deepEqual(validateCleanup(result), []);
  }

  it('safety.allowCleanup false: refused before connecting', async () => {
    const run = await clean({ environment: localEnvironment({ safety: { allowCleanup: false } }) });
    refusedBy(run, 'allow-cleanup');
    assert.equal(run.db.pool.connects, 0);
  });

  it('a prod-looking environment is refused', async () => {
    refusedBy(await clean({ environment: localEnvironment({ name: 'prod-mirror' }) }), 'not-prod');
  });

  it('a run id that is a prefix of another run id in results/', async () => {
    const resultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-prefix-'));
    fs.mkdirSync(path.join(resultsRoot, 'matcher-load-20261105-142233'));
    const run = await clean({ resultsRoot, scope: { runId: '20261105' } });
    refusedBy(run, 'run-id-unique');
    assert.match(guard(run.result, 'run-id-unique').detail, /20261105-142233/);
  });

  it('the wrong database', async () =>
    refusedBy(await clean({ db: { database: 'otherdb' } }), 'database-name'));
  it('low disk', async () => refusedBy(await clean({ freeGb: 5 }), 'disk-results'));
  it('an unhealthy slot', async () => {
    refusedBy(
      await clean({ db: { slots: () => [{ ...HEALTHY_SLOT, wal_status: 'unreserved' }] } }),
      'slot-health',
    );
  });
  it('due unprocessed transitions of this run (Step SLA still working)', async () =>
    refusedBy(await clean({ db: { due: 4 } }), 'due-transitions'));
  it('local: matcher consumer-group lag > 0', async () =>
    refusedBy(await clean({ lags: [12] }), 'matcher-idle'));

  it("dev/uat: this run's rows still growing over IDLE_FLAT_DURATION (lag is not used there)", async () => {
    const activity = [
      { protocol_instance: 3, matcher_event_log: 3 },
      { protocol_instance: 5, matcher_event_log: 5 },
    ];
    const run = await clean({ environment: devEnvironment(), db: { activity }, lags: [999] });
    refusedBy(run, 'matcher-idle');
    assert.ok(run.sleeps.includes(30_000), 'two counts IDLE_FLAT_DURATION apart');
    const activitySql = run.statements.find((s) => /AS protocol_instance, /.test(s));
    assert.match(activitySql, new RegExp(`LOADTEST-${RUN_ID}-mat-`));
  });

  it('dev/uat: flat counts pass even with real traffic lag', async () => {
    const run = await clean({ environment: devEnvironment(), lags: [999] });
    assert.equal(run.result.status, 'verified');
  });

  it('--wait waits until the matcher lag is 0', async () => {
    const run = await clean({ lags: [5, 0], wait: true });
    assert.equal(run.result.status, 'verified');
    assert.ok(run.sleeps.length > 0);
  });

  it('no typed "yes": refused after counting, nothing deleted', async () => {
    const run = await clean({ confirm: async () => false });
    refusedBy(run, 'confirmation');
    assert.ok(run.result.totals.before > 0, 'before counts are still reported');
  });
});

describe('runCleanup — modes and legacy branch', () => {
  it('dry-run stages and counts inside BEGIN … ROLLBACK and deletes nothing', async () => {
    const { result, statements } = await clean({ mode: 'dry-run' });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.mode, 'dry-run');
    assert.ok(!statements.some((s) => /^WITH b AS/.test(s)));
    const begin = statements.indexOf('BEGIN');
    assert.ok(begin >= 0 && begin < statements.findIndex((s) => s.startsWith('CREATE TEMP TABLE')));
    assert.equal(statements.at(-1), 'ROLLBACK');
    assert.ok(result.totals.before > 0);
  });

  it('legacy v1 branch: on for a v1 run id (auto), off for a default id', async () => {
    const legacy = await clean({ scope: { runId: '1103172520' } });
    assert.ok(
      legacy.statements.some((s) => /raw_payload->>'subject' LIKE 'LOADTEST-1103172520-%'/.test(s)),
    );
    assert.ok(
      legacy.statements.some((s) =>
        /data->'subject'->>'reference' LIKE 'Patient\/LOADTEST-1103172520-%'/.test(s),
      ),
    );
    assert.equal(legacy.result.scope.legacyV1, true);
    const modern = await clean();
    assert.ok(!modern.statements.some((s) => /raw_payload|->'subject'/.test(s)));
    assert.equal(modern.result.scope.legacyV1, false);
  });

  it('planScope: a custom run id (RUN_ID=baseline1) is not legacy and keeps the bounds of its run folder', () => {
    const resultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-scope-'));
    const settings = resolveSettings({ environment: localEnvironment(), env: {} });
    const writeContext = (runId, extra = {}) => {
      const dir = path.join(resultsRoot, `collector-load-${runId}`);
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, 'run-context.json'),
        JSON.stringify({
          runId,
          idCode: 'col',
          startedAt: '2026-11-05T14:22:33.000+05:30',
          dataset: { source: 'loadtest-emr' },
          phasePlan: { phases: [{ plannedEvents: 600 }, { plannedEvents: 30000 }] },
          ...extra,
        }),
      );
    };
    // The run overrode EVENT_SOURCE: cleanup must search the source the run really used.
    writeContext('baseline1', { settings: { EVENT_SOURCE: 'other-emr' } });
    const custom = planScope({ scope: { runId: 'baseline1' }, settings, resultsRoot });
    assert.equal(custom.legacyV1, false);
    assert.ok(custom.bounds?.floor, 'UUIDv7 floor kept');
    assert.equal(custom.bounds.source, 'other-emr');
    // Candidate ids carry the data checks' margin (1 % + 10): 600 → 616, 30000 → 30310.
    assert.deepEqual(custom.bounds.candidates.phases, [
      { phaseIndex: 0, plannedEvents: 616 },
      { phaseIndex: 1, plannedEvents: 30310 },
    ]);
    // Without its own EVENT_SOURCE the run used the dataset's source.
    writeContext('baseline2');
    assert.equal(
      planScope({ scope: { runId: 'baseline2' }, settings, resultsRoot }).bounds.source,
      'loadtest-emr',
    );
    // A 10-digit id is legacy (v1) unless its folder has a v2 run-context.json.
    assert.equal(
      planScope({ scope: { runId: '1103172520' }, settings, resultsRoot }).legacyV1,
      true,
    );
    writeContext('1234567890');
    assert.equal(
      planScope({ scope: { runId: '1234567890' }, settings, resultsRoot }).legacyV1,
      false,
    );
    // A custom id without a run folder: not legacy, no bounds (LIKE per id code).
    const bare = planScope({ scope: { runId: 'nofolder1' }, settings, resultsRoot });
    assert.equal(bare.legacyV1, false);
    assert.equal(bare.bounds, null);
    // With a run folder the start is exact.
    assert.equal(custom.bounds.startSource, 'run-context');
  });

  it('planScope: a default run id without run-context.json uses the earliest instant it can mean', () => {
    const resultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-scope-'));
    const settings = resolveSettings({ environment: localEnvironment(), env: {} });
    // 20261105-142233 made on an IST (+05:30) laptop really started at 08:52:33Z; whatever zone THIS
    // machine is in, the bound must not be later than that: 14:22:33 read as UTC minus 14 h.
    const guessed = planScope({ scope: { runId: '20261105-142233' }, settings, resultsRoot });
    assert.equal(guessed.bounds.runStart, '2026-11-05T00:22:33.000Z');
    assert.equal(guessed.bounds.startSource, 'run-id-earliest');
    assert.ok(new Date(guessed.bounds.runStart) <= new Date('2026-11-05T08:52:33Z'));
    // A run made at +14:00 (the furthest ahead of UTC) is still inside the bound.
    assert.ok(new Date(guessed.bounds.runStart) <= new Date('2026-11-05T00:22:33Z'));
  });

  it('legacy v1 branch: --legacy-v1 forces it, CLEANUP_LEGACY_V1=false turns auto off', async () => {
    const forced = await clean({ scope: { runId: RUN_ID, legacyV1: true } });
    assert.ok(forced.statements.some((s) => /raw_payload/.test(s)));
    const off = await clean({
      scope: { runId: '1103172520' },
      set: { CLEANUP_LEGACY_V1: 'false' },
    });
    assert.ok(!off.statements.some((s) => /raw_payload/.test(s)));
  });

  it('--all: LOADTEST- selector, legacy branch, facility included', async () => {
    const { result, statements } = await clean({ scope: { all: true } });
    assert.equal(result.status, 'verified');
    assert.deepEqual(result.scope.selectors, ['LOADTEST-']);
    assert.ok(statements.some((s) => batchTable(s) === 'facility'));
    assert.equal(result.tables.find((t) => t.table === 'facility').deleted, 1);
  });
});
