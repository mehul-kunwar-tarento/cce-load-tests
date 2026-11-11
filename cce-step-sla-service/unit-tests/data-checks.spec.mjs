/**
 * data-checks.spec.mjs — unit tests of the Step SLA data checks (data-checks/step-sla-data-checks.mjs).
 *
 * What:    The data checks are the Step SLA verdict (each alarm's wait, from the database). These tests prove,
 *          without a database (D14):
 *            - the query selects this run only: run selector LOADTEST-<runId>-sla-, UUIDv7 floor on
 *              protocol_instance.id (run start − 5 min), the max wait as a parameter, a statement_timeout;
 *            - PASS and FAIL of every check for a steady test (max wait < STEP_SLA_MAX_WAIT; handled = OVERDUE =
 *              deviations = alarm count) incl. "started breaking" = ring time of the first alarm over the limit;
 *            - the storm with v1's real numbers (100,000 alarms, p95 68.8 s, max 69.8 s): catch-up 69.8 s < 5 min
 *              passes, the drain average is reported; a stricter limit fails and says when it started breaking;
 *              an unfinished storm has NO catch-up time (D19).
 * How:     npm test   (or: node --test cce-step-sla-service/unit-tests/data-checks.spec.mjs)
 * Needs:   config/ and test-data/ of the repository (settings resolution, files only).
 * Outputs: node:test results.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ALARMS_SQL,
  buildAlarmQuery,
  judgeAlarmRow,
  runStepSlaDataChecks,
} from '../data-checks/step-sla-data-checks.mjs';
import { describeRun } from '../service-module.mjs';
import { uuidV7Floor } from '../shared.mjs';
import { buildCtx, fakePgPool, RUN_START } from './helpers.mjs';

/** The ring moment of the example runs. */
const RING = new Date('2026-11-05T14:24:00+05:30');

/** Seconds after RING as a Date; why: pg returns timestamptz columns as Date objects. */
const at = (seconds) => new Date(RING.getTime() + seconds * 1000);

/** A database row for a steady run where everything went fine (30,000 alarms at 50/s, longest wait 5 s). */
function loadRow(overrides = {}) {
  return {
    seeded: 30000,
    handled: 30000,
    overdue: 30000,
    deviations: 30000,
    wait_avg: 2.61,
    wait_p95: 4.9,
    wait_max: 5.0, // v1 local-4plans baseline: load longest wait 5 s
    first_ring: RING,
    last_ring: at(599.98),
    last_handled: at(604.2),
    over_limit: 0,
    started_breaking_at: null,
    ...overrides,
  };
}

/** v1's storm on the laptop: 100,000 alarms ringing at once, p95 68.8 s, max 69.8 s. */
function stormRow(overrides = {}) {
  return {
    seeded: 100000,
    handled: 100000,
    overdue: 100000,
    deviations: 100000,
    wait_avg: 35.1,
    wait_p95: 68.8,
    wait_max: 69.8,
    first_ring: RING,
    last_ring: RING,
    last_handled: at(69.8),
    over_limit: 0,
    started_breaking_at: null,
    ...overrides,
  };
}

/** The checks by id; why: assertions read better by name. */
function byId(checks) {
  return Object.fromEntries(checks.map((check) => [check.id, check]));
}

describe('buildAlarmQuery', () => {
  it('selects this run only: UUIDv7 floor (run start − 5 min), run selector, max wait as parameters', () => {
    const { sql, params } = buildAlarmQuery({
      selector: 'LOADTEST-20261105-142233-sla-',
      runStart: RUN_START.toISOString(),
      maxWaitSeconds: 10,
    });
    assert.equal(sql, ALARMS_SQL);
    assert.deepEqual(params, [
      uuidV7Floor(new Date(RUN_START.getTime() - 5 * 60_000)),
      'LOADTEST-20261105-142233-sla-%',
      10,
    ]);
    // Index-friendly: the primary-key range on protocol_instance comes first, then the patient prefix.
    assert.match(sql, /WHERE p\.id >= \$1::uuid AND p\.patient_id LIKE \$2/);
    assert.match(sql, /transition_type = 'DUE_DATE_REACHED'/);
    assert.match(sql, /d\.deviation_type = 'OVERDUE'/);
    assert.ok(!sql.includes('LOADTEST'), 'the selector is a parameter, never pasted into the SQL');
  });
});

describe('judgeAlarmRow (steady tests)', () => {
  const plan = { alarmCount: 30000, maxWaitSeconds: 10 };

  it('PASS: every alarm handled, OVERDUE, one deviation each, longest wait under the limit', () => {
    const checks = byId(
      judgeAlarmRow({ row: loadRow(), plan, testType: 'load', sql: 'SQL', durationMs: 12 }),
    );
    for (const id of [
      'step-sla.alarms-seeded',
      'step-sla.all-handled',
      'step-sla.all-overdue',
      'step-sla.deviations',
    ]) {
      assert.equal(checks[id].passed, true, id);
      assert.equal(checks[id].expected, 30000, id);
      assert.equal(checks[id].comparison, 'equals', id);
      assert.equal(checks[id].severity, 'required', id);
    }
    const maxWait = checks['step-sla.max-wait'];
    assert.equal(maxWait.passed, true);
    assert.equal(maxWait.actual, 5);
    assert.equal(maxWait.expected, 10);
    assert.equal(maxWait.comparison, 'at-most');
    assert.equal(maxWait.details.startedBreakingAt, null);
    assert.equal(maxWait.details.waitP95Seconds, 4.9);
    assert.equal(checks['step-sla.wait-avg'].actual, 2.61);
    assert.equal(checks['step-sla.wait-avg'].severity, 'info');
    assert.equal(checks['step-sla.wait-p95'].actual, 4.9);
    assert.ok(!checks['step-sla.storm-catch-up'], 'no storm check for a steady test');
    // The SQL is kept once (transparency), the duration on every check.
    assert.equal(checks['step-sla.alarms-seeded'].sql, 'SQL');
    assert.equal(checks['step-sla.all-handled'].durationMs, 12);
  });

  it('FAIL: a wait over the limit fails max-wait and says when it started breaking', () => {
    const row = loadRow({ wait_max: 14.2, over_limit: 1250, started_breaking_at: at(431.5) });
    const checks = byId(judgeAlarmRow({ row, plan, testType: 'load' }));
    const maxWait = checks['step-sla.max-wait'];
    assert.equal(maxWait.passed, false);
    assert.equal(maxWait.actual, 14.2);
    assert.equal(maxWait.details.alarmsOverLimit, 1250);
    assert.equal(maxWait.details.startedBreakingAt, at(431.5).toISOString());
    assert.equal(checks['step-sla.all-handled'].passed, true);
  });

  it('FAIL: alarms not handled, not OVERDUE or without deviation fail their own checks', () => {
    const row = loadRow({
      handled: 29000,
      overdue: 28990,
      deviations: 28980,
      wait_max: 6,
      over_limit: 1000, // still waiting past the limit (counted by the SQL)
      started_breaking_at: at(580),
    });
    const checks = byId(judgeAlarmRow({ row, plan, testType: 'stress' }));
    assert.equal(checks['step-sla.all-handled'].passed, false);
    assert.equal(checks['step-sla.all-handled'].actual, 29000);
    assert.equal(checks['step-sla.all-overdue'].passed, false);
    assert.equal(checks['step-sla.deviations'].passed, false);
    // The handled ones were quick, but 1,000 still wait past the limit: max-wait fails too.
    assert.equal(checks['step-sla.max-wait'].passed, false);
    assert.equal(checks['step-sla.max-wait'].details.startedBreakingAt, at(580).toISOString());
  });

  it('FAIL: nothing found (wrong database or selector) fails every count, no crash on nulls', () => {
    const empty = {
      seeded: 0,
      handled: 0,
      overdue: 0,
      deviations: 0,
      wait_avg: null,
      wait_p95: null,
      wait_max: null,
      first_ring: null,
      last_ring: null,
      last_handled: null,
      over_limit: 0,
      started_breaking_at: null,
    };
    const checks = byId(judgeAlarmRow({ row: empty, plan, testType: 'smoke' }));
    assert.equal(checks['step-sla.alarms-seeded'].passed, false);
    assert.equal(checks['step-sla.max-wait'].passed, false);
    assert.equal(checks['step-sla.max-wait'].actual, null);
  });
});

describe('judgeAlarmRow (storm = breakpoint)', () => {
  const plan = { alarmCount: 100000, maxWaitSeconds: 300 }; // STEP_SLA_STORM_MAX_CATCH_UP 5m

  it('PASS with the v1 storm numbers: caught up 69.8 s after the ring, under 5 min', () => {
    const checks = byId(judgeAlarmRow({ row: stormRow(), plan, testType: 'breakpoint' }));
    const storm = checks['step-sla.storm-catch-up'];
    assert.equal(storm.passed, true);
    assert.equal(storm.actual, 69.8);
    assert.equal(storm.expected, 300);
    assert.equal(storm.details.catchUpSeconds, 69.8);
    assert.equal(storm.details.waitP95Seconds, 68.8);
    assert.equal(storm.details.waitMaxSeconds, 69.8);
    // Average drain from the database: 100,000 / 69.8 s.
    assert.equal(checks['step-sla.storm-drain'].actual, 1432.7);
    assert.equal(checks['step-sla.storm-drain'].severity, 'info');
    assert.equal(checks['step-sla.wait-p95'].actual, 68.8);
    assert.ok(
      !checks['step-sla.max-wait'],
      'the storm is judged by catch-up, not the 2-poll max wait',
    );
  });

  it('FAIL with a stricter limit (60 s): started breaking at the ring', () => {
    const row = stormRow({ over_limit: 14000, started_breaking_at: RING });
    const checks = byId(
      judgeAlarmRow({
        row,
        plan: { alarmCount: 100000, maxWaitSeconds: 60 },
        testType: 'breakpoint',
      }),
    );
    const storm = checks['step-sla.storm-catch-up'];
    assert.equal(storm.passed, false);
    assert.equal(storm.actual, 69.8);
    assert.equal(storm.details.startedBreakingAt, RING.toISOString());
    assert.equal(storm.details.alarmsOverLimit, 14000);
  });

  it('an unfinished storm has no catch-up time at all (never "caught up after the give-up time", D19)', () => {
    const row = stormRow({
      handled: 61000,
      overdue: 61000,
      deviations: 61000,
      last_handled: at(900),
    });
    const checks = byId(judgeAlarmRow({ row, plan, testType: 'breakpoint' }));
    assert.equal(checks['step-sla.storm-catch-up'].passed, false);
    assert.equal(checks['step-sla.storm-catch-up'].actual, null);
    assert.equal(checks['step-sla.storm-catch-up'].details.catchUpSeconds, null);
    assert.equal(checks['step-sla.storm-drain'].actual, null);
  });
});

describe('runStepSlaDataChecks', () => {
  it('runs the query once with this run’s parameters and a statement_timeout', async () => {
    const pool = fakePgPool((sql) => (sql === ALARMS_SQL ? { rows: [loadRow()] } : undefined));
    const ctx = await buildCtx('load', { pgPool: pool });
    const plan = describeRun(ctx);
    const checks = await runStepSlaDataChecks(ctx, { plan, timeoutMs: 60_000 });

    const sqls = pool.statements.map((s) => s.sql);
    assert.deepEqual(sqls, ['BEGIN', 'SET LOCAL statement_timeout = 60000', ALARMS_SQL, 'COMMIT']);
    const query = pool.statements[2];
    assert.equal(query.params[1], `LOADTEST-${ctx.runId}-sla-%`);
    assert.equal(query.params[0], uuidV7Floor(new Date(RUN_START.getTime() - 5 * 60_000)));
    assert.equal(query.params[2], 10); // STEP_SLA_MAX_WAIT auto = 2 × 5 s
    assert.equal(byId(checks)['step-sla.max-wait'].passed, true);
    assert.equal(pool.releases, 1);
  });

  it('breakpoint passes STEP_SLA_STORM_MAX_CATCH_UP as the limit', async () => {
    const pool = fakePgPool((sql) => (sql === ALARMS_SQL ? { rows: [stormRow()] } : undefined));
    const ctx = await buildCtx('breakpoint', { pgPool: pool });
    const checks = await runStepSlaDataChecks(ctx, { plan: describeRun(ctx) });
    assert.equal(pool.statements.find((s) => s.sql === ALARMS_SQL).params[2], 300);
    assert.ok(pool.statements.some((s) => s.sql === 'SET LOCAL statement_timeout = 300000'));
    assert.equal(byId(checks)['step-sla.storm-catch-up'].passed, true);
  });

  it('refuses to guess the run start', async () => {
    const ctx = await buildCtx('smoke', { pgPool: fakePgPool() });
    ctx.context = { ...ctx.context, startedAt: undefined };
    await assert.rejects(runStepSlaDataChecks(ctx, { plan: describeRun(ctx) }), /run start/);
  });
});
