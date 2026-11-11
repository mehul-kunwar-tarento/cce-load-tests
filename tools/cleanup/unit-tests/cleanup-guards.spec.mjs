/**
 * cleanup-guards.spec.mjs — unit tests of tools/cleanup/cleanup-guards.mjs (the checks before deleting)
 *
 * What:    Each guard on its own: not-prod, allow-cleanup, run-id-unique (a run id that is a prefix of another
 *          run id in results/, read from folder names and run-context.json), database-name, disk (results and,
 *          on the laptop, Docker's data root; remote stores skipped), slot-health, and the "still processing"
 *          guards scoped to this run (due transitions; local: matcher lag; dev/uat: this run's rows growing
 *          over IDLE_FLAT_DURATION; --wait retrying until IDLE_TIMEOUT).
 * How:     npm test   (or: node --test tools/cleanup/unit-tests/cleanup-guards.spec.mjs)
 * Needs:   Fakes and temporary folders only.
 * Outputs: node:test results only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { resolveSettings } from '../../core/settings.mjs';
import { devEnvironment, localEnvironment } from '../../preflight/unit-tests/fake-clients.mjs';
import {
  guardAllowCleanup,
  guardDatabaseName,
  guardDisk,
  guardNotProd,
  guardProcessing,
  guardRunIdUnique,
  guardSlots,
  knownRunIds,
} from '../cleanup-guards.mjs';
import { buildSelectors } from '../cleanup-tables.mjs';
import { HEALTHY_SLOT, fakeExec, fakeKafkaAdmin, fakeStatfs } from './fake-pg.mjs';

const settings = resolveSettings({ environment: localEnvironment(), env: {} });

/** A query function answering by regex. */
const queryFrom = (answers) => async (sql) => {
  for (const [re, rows] of answers)
    if (re.test(sql)) return typeof rows === 'function' ? rows() : rows;
  return [];
};

describe('static guards', () => {
  it('not-prod and allow-cleanup', () => {
    assert.equal(guardNotProd(localEnvironment()).status, 'pass');
    assert.equal(guardNotProd({ name: 'prod', kind: 'local' }).status, 'fail');
    assert.equal(guardNotProd({ name: 'x', kind: 'production' }).status, 'fail');
    assert.equal(guardAllowCleanup(localEnvironment()).status, 'pass');
    assert.equal(guardAllowCleanup(localEnvironment({ safety: {} })).status, 'fail');
  });

  it('run-id-unique: refuses a run id that is a prefix of another run id in results/', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guards-ids-'));
    fs.mkdirSync(path.join(root, 'collector-smoke-20261105-142233'));
    fs.mkdirSync(path.join(root, 'custom-run'));
    fs.writeFileSync(
      path.join(root, 'custom-run', 'run-context.json'),
      JSON.stringify({ runId: 'test2' }),
    );
    assert.deepEqual([...knownRunIds(root)].sort(), ['20261105-142233', 'test2']);
    assert.equal(guardRunIdUnique({ runId: '20261105' }, root).status, 'fail');
    assert.equal(guardRunIdUnique({ runId: '20261105-142233' }, root).status, 'pass');
    // 'test' vs 'test2': no hyphen follows, so they cannot collide (selectors end with the id code).
    assert.equal(guardRunIdUnique({ runId: 'test' }, root).status, 'pass');
    assert.equal(guardRunIdUnique({ all: true }, root).status, 'skip');
  });

  it('database-name', async () => {
    const env = localEnvironment();
    assert.equal(
      (await guardDatabaseName(queryFrom([[/current_database/, [{ database: 'ccedb' }]]]), env))
        .status,
      'pass',
    );
    assert.equal(
      (await guardDatabaseName(queryFrom([[/current_database/, [{ database: 'other' }]]]), env))
        .status,
      'fail',
    );
  });
});

describe('guardDisk', () => {
  const resultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guards-disk-'));
  it('local: results and Docker data root against MIN_FREE_DISK_GB', async () => {
    const ok = await guardDisk({
      environment: localEnvironment(),
      settings,
      resultsRoot,
      statfs: fakeStatfs(50),
      exec: fakeExec,
      query: null,
    });
    assert.deepEqual(
      ok.guards.map((g) => [g.id, g.status]),
      [
        ['disk-results', 'pass'],
        ['disk-data-stores', 'pass'],
      ],
    );
    assert.equal(ok.disk.dataStoresSource, 'docker-root');
    const low = await guardDisk({
      environment: localEnvironment(),
      settings,
      resultsRoot,
      statfs: fakeStatfs(10),
      exec: fakeExec,
      query: null,
    });
    assert.deepEqual(
      low.guards.map((g) => g.status),
      ['fail', 'fail'],
    );
  });
  it('dev: remote data stores are not measurable here (skip), results still checked', async () => {
    const dev = await guardDisk({
      environment: devEnvironment(),
      settings,
      resultsRoot,
      statfs: fakeStatfs(50),
      exec: fakeExec,
      query: null,
    });
    assert.deepEqual(
      dev.guards.map((g) => [g.id, g.status]),
      [
        ['disk-results', 'pass'],
        ['disk-data-stores', 'skip'],
      ],
    );
  });
});

describe('guardSlots', () => {
  it('passes reserved slots with headroom, fails lost ones', async () => {
    const healthy = await guardSlots(
      queryFrom([[/pg_replication_slots/, [{ ...HEALTHY_SLOT }]]]),
      settings,
    );
    assert.equal(healthy.guard.status, 'pass');
    assert.equal(healthy.wal.slots[0].walStatus, 'reserved');
    const lost = await guardSlots(
      queryFrom([[/pg_replication_slots/, [{ ...HEALTHY_SLOT, wal_status: 'lost' }]]]),
      settings,
    );
    assert.equal(lost.guard.status, 'fail');
  });
});

describe('guardProcessing (scoped to this run)', () => {
  const options = {
    selectors: buildSelectors({ runId: '20261105-142233' }),
    all: false,
    legacyV1: false,
    bounds: null,
    schema: null,
  };
  const idleQuery = queryFrom([
    [/next_attempt_at/, [{ n: 0 }]],
    [/AS protocol_instance, /, [{ protocol_instance: 1, matcher_event_log: 1 }]],
  ]);

  it('local: due transitions and matcher lag', async () => {
    const env = localEnvironment();
    const sleep = async () => {};
    const idle = await guardProcessing({
      query: idleQuery,
      environment: env,
      settings,
      options,
      kafkaAdmin: fakeKafkaAdmin([0]),
      sleep,
    });
    assert.deepEqual(
      idle.map((g) => [g.id, g.status]),
      [
        ['due-transitions', 'pass'],
        ['matcher-idle', 'pass'],
      ],
    );
    const busy = await guardProcessing({
      query: queryFrom([[/next_attempt_at/, [{ n: 3 }]]]),
      environment: env,
      settings,
      options,
      kafkaAdmin: fakeKafkaAdmin([7]),
      sleep,
    });
    assert.deepEqual(
      busy.map((g) => g.status),
      ['fail', 'fail'],
    );
  });

  it('due-transitions: alarms ringing within IDLE_TIMEOUT refuse; later SLA deadlines are only reported', async () => {
    const seen = [];
    const query = async (sql) => {
      seen.push(sql);
      if (/next_attempt_at/.test(sql))
        return [{ n: 5, due_now: 1, later: 40, last_soon: '2026-11-06T10:04:00Z' }];
      return [];
    };
    const [due] = await guardProcessing({
      query,
      environment: localEnvironment(),
      settings,
      options,
      kafkaAdmin: fakeKafkaAdmin([0]),
      sleep: async () => {},
    });
    assert.equal(due.status, 'fail');
    // Future rings too, not only rows already due: Step SLA would judge them during the delete.
    assert.match(seen[0], /next_attempt_at <= now\(\) \+ interval '300 seconds'/);
    assert.match(seen[0], /WHERE NOT t\.is_processed$/);
    assert.match(due.detail, /5 unprocessed transition\(s\) .* within 300 s \(1 already due\)/);
    assert.match(due.detail, /2026-11-06T10:04:00\.000Z/);
    assert.match(due.detail, /40 more ring later/);
    const [later] = await guardProcessing({
      query: async (sql) => (/next_attempt_at/.test(sql) ? [{ n: 0, due_now: 0, later: 40 }] : []),
      environment: localEnvironment(),
      settings,
      options,
      kafkaAdmin: fakeKafkaAdmin([0]),
      sleep: async () => {},
    });
    assert.equal(
      later.status,
      'pass',
      'day-long SLA deadlines of a matcher run do not block cleanup',
    );
  });

  it("dev/uat: compares this run's row counts IDLE_FLAT_DURATION apart (never the lag)", async () => {
    const counts = [
      { protocol_instance: 1, matcher_event_log: 1 },
      { protocol_instance: 2, matcher_event_log: 1 },
    ];
    const query = queryFrom([
      [/next_attempt_at/, [{ n: 0 }]],
      [/AS protocol_instance, /, () => [counts.shift()]],
    ]);
    const sleeps = [];
    const lagNeverRead = {
      getGroupLag: async () => assert.fail('lag must not be read on dev/uat'),
    };
    const guards = await guardProcessing({
      query,
      environment: devEnvironment(),
      settings,
      options,
      kafkaAdmin: lagNeverRead,
      sleep: async (ms) => sleeps.push(ms),
    });
    assert.equal(guards.find((g) => g.id === 'matcher-idle').status, 'fail');
    assert.deepEqual(sleeps, [30_000]);
  });

  it('--wait retries until idle, and gives up at IDLE_TIMEOUT', async () => {
    let clock = 0;
    const now = () => new Date(clock);
    const sleep = async (ms) => {
      clock += ms;
    };
    const waited = await guardProcessing({
      query: idleQuery,
      environment: localEnvironment(),
      settings,
      options,
      kafkaAdmin: fakeKafkaAdmin([4, 2, 0]),
      sleep,
      wait: true,
      now,
    });
    assert.equal(waited.find((g) => g.id === 'matcher-idle').status, 'pass');
    clock = 0;
    const gaveUp = await guardProcessing({
      query: idleQuery,
      environment: localEnvironment(),
      settings,
      options,
      kafkaAdmin: fakeKafkaAdmin([9]),
      sleep,
      wait: true,
      now,
    });
    assert.equal(gaveUp.find((g) => g.id === 'matcher-idle').status, 'fail');
    assert.ok(clock >= 300_000, 'waited up to IDLE_TIMEOUT (5 min)');
  });
});
