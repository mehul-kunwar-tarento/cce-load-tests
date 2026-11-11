/**
 * seed-alarms.spec.mjs — unit tests of the Step SLA seeding (seeding/seed-alarms.mjs) with a fake Postgres.
 *
 * What:    Checks what is sent to the database and what comes back, without a database (D14):
 *          ONE client and ONE transaction (BEGIN … COMMIT, ROLLBACK on refusal), parameterised SQL (no run id or
 *          protocol id pasted into the text), UUIDv7 ids, patients LOADTEST-<runId>-sla-0-<n>, DUE rows only by
 *          default, the protocol_instance_history / step_instance_history rows the matcher also writes, both
 *          seed modes (set: kenya-sha-emr-service spreads over its 4 mandatory steps with a deadline, not the
 *          mandatory consent-request without one; single-action: v1), the
 *          refusals (action not mandatory or without a deadline, plan definition not ACTIVE), seed.json and the ring times returned to
 *          the runner (PrepareResult).
 * How:     npm test   (or: node --test cce-step-sla-service/unit-tests/seed-alarms.spec.mjs)
 * Needs:   config/ and test-data/ (plan-definition sets), files only.
 * Outputs: node:test results; temporary results folders.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { describeRun } from '../service-module.mjs';
import {
  ACTIVE_DEFINITION_SQL,
  buildSeedPairs,
  buildSeedStatements,
  MISSED_AFTER_DAYS,
  seedAlarms,
} from '../seeding/seed-alarms.mjs';
import { RefusedError, toIsoWithOffset, UUID_V7_SQL } from '../shared.mjs';
import { buildCtx, fakePgPool } from './helpers.mjs';

const RING_START_MS = Date.parse('2026-11-05T14:24:00+05:30');

/**
 * A fake database that knows the ACTIVE plan definitions and answers the summary queries like Postgres would
 * for the staged alarms (round-robin over the pairs given in the stage statement's parameters).
 */
function seedDatabase({ active = null, ratePerSecond, count }) {
  let stage = null;
  return fakePgPool((sql, params) => {
    if (sql === ACTIVE_DEFINITION_SQL) {
      const canonical = `${params[0]}|${params[1]}`;
      if (active && !active.includes(canonical)) return { rows: [] };
      return { rows: [{ id: `id-${params[0].split('/').pop()}` }] };
    }
    if (sql.startsWith('CREATE TEMP TABLE lt_seed')) stage = params;
    if (sql.startsWith('SELECT count(*)::int AS alarms')) {
      const end =
        ratePerSecond > 0 ? RING_START_MS + ((count - 1) / ratePerSecond) * 1000 : RING_START_MS;
      return {
        rows: [
          {
            alarms: count,
            ring_start_ms: String(RING_START_MS), // bigint comes back as a string from pg
            ring_end_ms: String(Math.round(end)),
            seeded_at_ms: String(RING_START_MS - 60_000),
          },
        ],
      };
    }
    if (sql.startsWith('SELECT protocol_definition_id::text')) {
      const [ids, actions] = stage;
      const counts = new Map();
      for (let n = 0; n < count; n += 1) {
        const key = `${ids[n % ids.length]}|${actions[n % actions.length]}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return {
        rows: [...counts].map(([key, alarms]) => {
          const [protocol_definition_id, action_id] = key.split('|');
          return { protocol_definition_id, action_id, alarms };
        }),
      };
    }
    return undefined;
  });
}

describe('buildSeedPairs', () => {
  it('set mode: every mandatory step with a deadline, kenya-sha-emr-service = 4 pairs', async () => {
    const ctx = await buildCtx('smoke', {
      overrides: { PLAN_DEFINITION_SET: 'kenya-sha-emr-service' },
    });
    const pairs = buildSeedPairs({ planDefinitionSet: ctx.planDefinitionSet, seedMode: 'set' });
    // consent-request is mandatory but has no tolerance-days: the matcher never gives it an alarm.
    assert.deepEqual(
      pairs.map((p) => p.actionId),
      ['consent-verification', 'visit-encounter', 'patient-check-in', 'diagnosis'],
    );
    assert.deepEqual(pairs[0], {
      url: 'http://openphc.org/PlanDefinition/kenya-sha-emr-service-protocol',
      version: '1.0.0',
      canonical: 'http://openphc.org/PlanDefinition/kenya-sha-emr-service-protocol|1.0.0',
      actionId: 'consent-verification',
    });
  });

  it('set mode: emr-service = its 3 mandatory steps (all have a deadline)', async () => {
    const ctx = await buildCtx('smoke');
    const pairs = buildSeedPairs({ planDefinitionSet: ctx.planDefinitionSet, seedMode: 'set' });
    assert.deepEqual(
      pairs.map((p) => p.actionId),
      ['vitals-recording', 'consultation', 'diagnosis'],
    );
  });

  it('single-action mode: the first plan definition and the chosen mandatory action only', async () => {
    const ctx = await buildCtx('smoke');
    const pairs = buildSeedPairs({
      planDefinitionSet: ctx.planDefinitionSet,
      seedMode: 'single-action',
      actionId: 'consultation',
    });
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].actionId, 'consultation');
    assert.match(pairs[0].canonical, /emr-service-protocol\|1\.0\.0$/);
  });

  it('single-action mode refuses a mandatory action without a deadline', async () => {
    const ctx = await buildCtx('smoke', {
      overrides: { PLAN_DEFINITION_SET: 'kenya-sha-emr-service' },
    });
    assert.throws(
      () =>
        buildSeedPairs({
          planDefinitionSet: ctx.planDefinitionSet,
          seedMode: 'single-action',
          actionId: 'consent-request',
        }),
      /consent-request is not a mandatory \("must"\) action with a deadline/,
    );
  });

  it('single-action mode refuses an action that is not mandatory in the first plan definition', async () => {
    const ctx = await buildCtx('smoke');
    assert.throws(
      () =>
        buildSeedPairs({
          planDefinitionSet: ctx.planDefinitionSet,
          seedMode: 'single-action',
          actionId: 'lab-order',
        }),
      (error) =>
        error instanceof RefusedError && /not a mandatory \("must"\) action/.test(error.message),
    );
  });

  it('refuses a set without plan definitions or without mandatory steps', () => {
    assert.throws(
      () =>
        buildSeedPairs({ planDefinitionSet: { name: 'x', planDefinitions: [] }, seedMode: 'set' }),
      RefusedError,
    );
    assert.throws(
      () =>
        buildSeedPairs({
          planDefinitionSet: {
            name: 'x',
            planDefinitions: [{ url: 'u', version: '1', mandatorySteps: [] }],
          },
          seedMode: 'set',
        }),
      /no mandatory steps/,
    );
  });
});

describe('buildSeedStatements', () => {
  it('keeps every value a parameter and uses UUIDv7 ids', () => {
    const statements = buildSeedStatements({
      protocolDefinitionIds: ['p1', 'p2'],
      actionIds: ['a1', 'a2'],
      alarmCount: 30,
      ratePerSecond: 1,
      firstRingDelaySeconds: 60,
      patientIdPrefix: 'LOADTEST-20261105-142233-sla-0-',
      seedMissed: false,
    });
    assert.deepEqual(
      statements.map((s) => s.name),
      [
        'stage alarms',
        'insert protocol_instance',
        'insert protocol_instance_history',
        'insert step_instance',
        'insert step_instance_history',
        'insert DUE alarms',
        'summary',
        'alarms per pair',
      ],
    );
    const text = statements.map((s) => s.sql).join('\n');
    assert.ok(!text.includes('LOADTEST'), 'the patient prefix is a parameter, not SQL text');
    assert.ok(!text.includes('MISSED_DATE_REACHED'), 'no MISSED alarms by default');
    const byName = Object.fromEntries(statements.map((s) => [s.name, s]));
    assert.ok(statements[0].sql.includes(UUID_V7_SQL));
    assert.ok(byName['insert DUE alarms'].sql.includes(UUID_V7_SQL));
    assert.deepEqual(statements[0].params, [['p1', 'p2'], ['a1', 'a2'], 30, 60, 1, 2]);
    assert.deepEqual(byName['insert protocol_instance'].params, [
      'LOADTEST-20261105-142233-sla-0-',
      14,
    ]);
    // Both gates of Step SLA's fetch get the ring time; the step is mandatory and not done.
    assert.match(byName['insert DUE alarms'].sql, /'DUE_DATE_REACHED', ring, false, 0, ring/);
    assert.match(byName['insert step_instance'].sql, /'NOT_STARTED', ring, 'must'/);
    // History rows as the matcher writes them: the enrolment ACTIVE at enrolled_at (ring − 14 days, the same
    // parameter as protocol_instance), the step NOT_STARTED with no SLA status yet; ids from the column default.
    assert.match(
      byName['insert protocol_instance_history'].sql,
      /^INSERT INTO protocol_instance_history \(protocol_instance_id, status, changed_at\)\nSELECT protocol_instance_id, 'ACTIVE', ring - make_interval\(days => \$1::int\)/,
    );
    assert.deepEqual(byName['insert protocol_instance_history'].params, [14]);
    assert.match(
      byName['insert step_instance_history'].sql,
      /^INSERT INTO step_instance_history \(step_instance_id, step_status, sla_status, changed_at\)\nSELECT step_instance_id, 'NOT_STARTED', NULL, now\(\)/,
    );
    assert.deepEqual(byName['insert step_instance_history'].params, []);
    // Each history row follows its base row (same order as the matcher's transaction).
    const order = statements.map((s) => s.name);
    assert.ok(
      order.indexOf('insert protocol_instance_history') > order.indexOf('insert protocol_instance'),
    );
    assert.ok(
      order.indexOf('insert step_instance_history') > order.indexOf('insert step_instance'),
    );
    // Alarm n (0-based) → pair n mod P; ring = start + n / rate.
    assert.match(statements[0].sql, /generate_series\(0, \$3::int - 1\)/);
    assert.match(statements[0].sql, /g\.n % \$6::int/);
  });

  it('adds MISSED alarms 3 days after the ring only on request', () => {
    const statements = buildSeedStatements({
      protocolDefinitionIds: ['p1'],
      actionIds: ['a1'],
      alarmCount: 1,
      ratePerSecond: 0,
      firstRingDelaySeconds: 60,
      patientIdPrefix: 'x-',
      seedMissed: true,
    });
    const missed = statements.find((s) => s.name === 'insert MISSED alarms');
    assert.ok(missed);
    assert.deepEqual(missed.params, [MISSED_AFTER_DAYS]);
  });
});

describe('seedAlarms', () => {
  it('set mode over kenya-sha-emr-service: one client, one transaction, 4 pairs, seed.json, PrepareResult', async () => {
    const ctx = await buildCtx('smoke', {
      overrides: { PLAN_DEFINITION_SET: 'kenya-sha-emr-service' },
    });
    const plan = describeRun(ctx);
    const pool = seedDatabase({ ratePerSecond: plan.ratePerSecond, count: plan.alarmCount });
    ctx.pgPool = pool;
    const result = await seedAlarms(ctx, plan, { now: () => RING_START_MS - 50_000 });

    assert.equal(pool.connects, 1);
    assert.equal(pool.releases, 1);
    const sqls = pool.statements.map((s) => s.sql);
    assert.equal(sqls[0], 'BEGIN');
    assert.equal(sqls.at(-1), 'COMMIT');
    assert.equal(sqls.filter((s) => s === ACTIVE_DEFINITION_SQL).length, 1); // one lookup per plan definition
    assert.ok(!sqls.includes('ROLLBACK'));
    const stage = pool.statements.find((s) => s.sql.startsWith('CREATE TEMP TABLE lt_seed'));
    assert.equal(stage.params[0].length, 4);
    assert.equal(stage.params[2], 30); // alarm count from the phase plan
    assert.equal(stage.params[3], 60); // STEP_SLA_FIRST_RING_DELAY
    assert.equal(stage.params[4], 1); // ring rate
    const patients = pool.statements.find((s) => s.sql.startsWith('INSERT INTO protocol_instance'));
    assert.equal(patients.params[0], `LOADTEST-${ctx.runId}-sla-0-`);

    assert.deepEqual(result, {
      measureStart: toIsoWithOffset(new Date(RING_START_MS)),
      sendEnd: toIsoWithOffset(new Date(RING_START_MS + 29_000)),
      plannedEvents: 30,
      manifestFile: 'seed.json',
    });

    const manifest = JSON.parse(fs.readFileSync(path.join(ctx.resultsDir, 'seed.json'), 'utf8'));
    for (const field of [
      'runId',
      'alarmCount',
      'ratePerSecond',
      'ringStartMs',
      'ringEndMs',
      'seedMode',
      'pairs',
      'missedSeeded',
      'missedRingStartMs',
      'seededAt',
    ]) {
      assert.ok(field in manifest, `seed.json has ${field}`);
    }
    assert.equal(manifest.runId, ctx.runId);
    assert.equal(manifest.seedMode, 'set');
    assert.equal(manifest.planDefinitionSet, 'kenya-sha-emr-service');
    assert.equal(manifest.pairs.length, 4);
    assert.equal(
      manifest.pairs.reduce((sum, p) => sum + p.alarms, 0),
      30,
    );
    // Round robin: 30 alarms over 4 pairs → the first 2 pairs get 8, the last 2 get 7.
    assert.deepEqual(
      manifest.pairs.map((p) => p.alarms),
      [8, 8, 7, 7],
    );
    assert.deepEqual(Object.keys(manifest.pairs[0]).sort(), [
      'actionId',
      'alarms',
      'canonical',
      'protocolDefinitionId',
    ]);
    assert.equal(manifest.missedSeeded, false);
    assert.equal(manifest.missedRingStartMs, null);
    assert.deepEqual(manifest.warnings, []);
  });

  it('single-action mode reproduces v1: one plan definition, one action', async () => {
    const ctx = await buildCtx('load', { overrides: { STEP_SLA_SEED_MODE: 'single-action' } });
    const plan = describeRun(ctx);
    ctx.pgPool = seedDatabase({ ratePerSecond: plan.ratePerSecond, count: plan.alarmCount });
    await seedAlarms(ctx, plan, { now: () => RING_START_MS - 1000 });
    const manifest = JSON.parse(fs.readFileSync(path.join(ctx.resultsDir, 'seed.json'), 'utf8'));
    assert.equal(manifest.seedMode, 'single-action');
    assert.equal(manifest.pairs.length, 1);
    assert.equal(manifest.pairs[0].actionId, 'vitals-recording');
    assert.equal(manifest.pairs[0].alarms, 30000);
    assert.equal(manifest.ringEndMs - manifest.ringStartMs, Math.round((29_999 / 50) * 1000));
  });

  it('refuses a non-mandatory STEP_SLA_ACTION_ID before connecting', async () => {
    const ctx = await buildCtx('smoke', {
      overrides: { STEP_SLA_SEED_MODE: 'single-action', STEP_SLA_ACTION_ID: 'lab-order' },
    });
    const pool = seedDatabase({ ratePerSecond: 1, count: 30 });
    ctx.pgPool = pool;
    await assert.rejects(seedAlarms(ctx, describeRun(ctx)), RefusedError);
    assert.equal(pool.connects, 0);
  });

  it('refuses (and rolls back) when a plan definition of the set is not ACTIVE', async () => {
    const ctx = await buildCtx('smoke', {
      overrides: { PLAN_DEFINITION_SET: 'kenya-sha-emr-service' },
    });
    const pool = seedDatabase({
      active: ['http://openphc.org/PlanDefinition/emr-service-protocol|1.0.0'],
      ratePerSecond: 1,
      count: 30,
    });
    ctx.pgPool = pool;
    await assert.rejects(seedAlarms(ctx, describeRun(ctx)), (error) => {
      assert.ok(error instanceof RefusedError);
      assert.match(error.message, /kenya-sha-emr-service-protocol\|1\.0\.0 is not ACTIVE/);
      assert.match(
        error.message,
        /manage-plan-definitions\.sh load <env> --set kenya-sha-emr-service/,
      );
      return true;
    });
    const sqls = pool.statements.map((s) => s.sql);
    assert.ok(sqls.includes('ROLLBACK'));
    assert.ok(!sqls.includes('COMMIT'));
    assert.ok(!sqls.some((s) => s.startsWith('INSERT')));
    assert.equal(pool.releases, 1);
    assert.ok(!fs.existsSync(path.join(ctx.resultsDir, 'seed.json')));
  });

  it('storm: rate 0, every alarm rings at the same moment', async () => {
    const ctx = await buildCtx('breakpoint', { overrides: { STEP_SLA_STORM_ALARMS: '500' } });
    const plan = describeRun(ctx);
    ctx.pgPool = seedDatabase({ ratePerSecond: 0, count: 500 });
    const result = await seedAlarms(ctx, plan, { now: () => RING_START_MS - 1000 });
    assert.equal(result.measureStart, result.sendEnd);
    assert.equal(result.plannedEvents, 500);
    const stage = ctx.pgPool.statements.find((s) => s.sql.startsWith('CREATE TEMP TABLE lt_seed'));
    assert.equal(stage.params[4], 0);
  });

  it('seeds MISSED alarms only with STEP_SLA_SEED_MISSED_ALARMS=true and records it', async () => {
    const ctx = await buildCtx('smoke', { overrides: { STEP_SLA_SEED_MISSED_ALARMS: 'true' } });
    const plan = describeRun(ctx);
    ctx.pgPool = seedDatabase({ ratePerSecond: 1, count: 30 });
    await seedAlarms(ctx, plan, { now: () => RING_START_MS - 1000 });
    assert.ok(ctx.pgPool.statements.some((s) => s.sql.includes("'MISSED_DATE_REACHED'")));
    const manifest = JSON.parse(fs.readFileSync(path.join(ctx.resultsDir, 'seed.json'), 'utf8'));
    assert.equal(manifest.missedSeeded, true);
    assert.equal(manifest.missedRingStartMs, RING_START_MS + 3 * 86_400_000);
  });

  it('warns when seeding took longer than the first-ring delay', async () => {
    const ctx = await buildCtx('smoke');
    const plan = describeRun(ctx);
    ctx.pgPool = seedDatabase({ ratePerSecond: 1, count: 30 });
    await seedAlarms(ctx, plan, { now: () => RING_START_MS + 4_000 });
    const manifest = JSON.parse(fs.readFileSync(path.join(ctx.resultsDir, 'seed.json'), 'utf8'));
    assert.equal(manifest.warnings.length, 1);
    assert.match(manifest.warnings[0], /rang 4 s before they were committed/);
  });

  it('refuses without a database pool', async () => {
    const ctx = await buildCtx('smoke');
    await assert.rejects(seedAlarms(ctx, describeRun(ctx)), /needs Postgres/);
  });
});
