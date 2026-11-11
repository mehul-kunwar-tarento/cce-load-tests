/**
 * service-module.spec.mjs — unit tests of the Step SLA service module (service-module.mjs).
 *
 * What:    Proves the plug-in the shared runner sees (plan §6.4) is right, without any service (D14):
 *            - shape: kind 'seeded', breakpointKind 'none', requires (no Kafka), testFile → existing files,
 *              sampled metrics as SampledMetric objects (incl. the key the slaBatchesFailed peak reads);
 *            - expectation in ALARMS/s against STEP_SLA_PEAK_ALARM_RATE (auto = PEAK_RATE × DUE alarms per
 *              event: emr-service 50, kenya-sha-emr-service 50), never the events/s PEAK_RATE;
 *            - evaluate: load unit 'alarms', catch-up and "started breaking" from the database checks, storm
 *              rateAtBreak null, not-caught-up never has a catch-up time (D19), notes from seed.json;
 *            - baselineMetrics: the plan §8.3 step-sla keys;
 *            - ignored overrides (WARM_UP_*, DATASET, …) set for the run are warned about by prepare(), before seeding;
 *            - a whole result.json built by the shared result builder from a seeded run is valid and carries
 *              timing 'seed', load.unit 'alarms' and serviceMetrics.peaks['step-sla'].slaCycleCapHits.
 * How:     npm test   (or: node --test cce-step-sla-service/unit-tests/service-module.spec.mjs)
 * Needs:   config/ and test-data/ of the repository (settings resolution, files only).
 * Outputs: node:test results; temporary results folders.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import stepSlaModule, {
  describeRun,
  SETTINGS_NOT_USED,
  TEST_DEFINITIONS,
  unusedSettingWarnings,
} from '../service-module.mjs';
import {
  buildResult,
  buildRunContext,
  loadEnvironment,
  toIsoWithOffset,
  validateResult,
  validateServiceModule,
} from '../shared.mjs';
import { buildCtx, resolveStepSla, RUN_START } from './helpers.mjs';

const RING = Date.parse('2026-11-05T14:24:00+05:30');

/** Data checks as the database would give them for a run (all passing unless overridden). */
function passingChecks({ alarms, storm = false, lastHandledAfterRing = 6, handled = alarms }) {
  const lastRing = storm ? RING : RING + 29_000;
  const details = {
    startedBreakingAt: null,
    alarmsOverLimit: 0,
    limitSeconds: storm ? 300 : 10,
    firstRing: new Date(RING).toISOString(),
    lastRing: new Date(lastRing).toISOString(),
    lastHandled: new Date(lastRing + lastHandledAfterRing * 1000).toISOString(),
    handled,
    seeded: alarms,
    waitAvgSeconds: 2.4,
    waitP95Seconds: 4.8,
    waitMaxSeconds: 5.1,
  };
  const equals = (id, actual) => ({
    id,
    description: id,
    expected: alarms,
    actual,
    comparison: 'equals',
    passed: actual === alarms,
    severity: 'required',
  });
  return [
    equals('step-sla.alarms-seeded', alarms),
    equals('step-sla.all-handled', handled),
    equals('step-sla.all-overdue', handled),
    equals('step-sla.deviations', handled),
    storm
      ? {
          id: 'step-sla.storm-catch-up',
          description: 'storm',
          expected: 300,
          actual: handled === alarms ? lastHandledAfterRing : null,
          comparison: 'at-most',
          passed: handled === alarms && lastHandledAfterRing < 300,
          severity: 'required',
          details,
        }
      : {
          id: 'step-sla.max-wait',
          description: 'max wait',
          expected: 10,
          actual: 5.1,
          comparison: 'at-most',
          passed: true,
          severity: 'required',
          details,
        },
    {
      id: 'step-sla.wait-p95',
      description: 'p95',
      expected: null,
      actual: 4.8,
      comparison: 'at-most',
      passed: true,
      severity: 'info',
    },
  ];
}

describe('Step SLA service module shape', () => {
  it('is a valid seeded module with breakpoint kind none and no Kafka', () => {
    assert.deepEqual(validateServiceModule(stepSlaModule), []);
    assert.equal(stepSlaModule.service, 'cce-step-sla-service');
    assert.equal(stepSlaModule.subject, 'step-sla');
    assert.equal(stepSlaModule.idCode, 'sla');
    assert.equal(stepSlaModule.kind, 'seeded');
    assert.equal(stepSlaModule.breakpointKind, 'none');
    assert.deepEqual(stepSlaModule.testTypes, ['smoke', 'load', 'stress', 'breakpoint']);
    assert.deepEqual(stepSlaModule.requires, {
      services: ['step-sla'],
      postgres: true,
      kafka: false,
      protocol: true,
    });
    assert.equal(typeof stepSlaModule.waitForIdle, 'function');
    assert.equal(typeof stepSlaModule.prepare, 'function');
    assert.equal(stepSlaModule.watchers.length, 1);
  });

  it('testFile(type) is a module-relative URL of an existing test definition', () => {
    for (const type of stepSlaModule.testTypes) {
      const url = stepSlaModule.testFile(type);
      assert.ok(url instanceof URL);
      assert.ok(url.pathname.endsWith(`/cce-step-sla-service/tests/step-sla-${type}.test.mjs`));
      assert.ok(fs.existsSync(fileURLToPath(url)), type);
      assert.equal(TEST_DEFINITIONS[type].testType, type);
    }
  });

  it('sampled metrics are SampledMetric objects; slaBatchesFailed is the key the peak reads', () => {
    const keys = stepSlaModule.sampledMetrics.map((m) => m.key);
    assert.deepEqual(keys, ['slaDue', 'slaApplied', 'slaSkipped', 'slaCycles', 'slaBatchesFailed']);
    for (const metric of stepSlaModule.sampledMetrics) {
      assert.match(metric.name, /^cce_sla_/);
      assert.ok(['sum', 'max'].includes(metric.agg));
      assert.equal(typeof metric.unit, 'string');
    }
    const batches = stepSlaModule.sampledMetrics.find((m) => m.key === 'slaBatchesFailed');
    assert.equal(batches.name, 'cce_sla_evaluator_batches_failed_total');
  });

  it('describeRun works with the check-data ctx too (settings values + phase plan, no resolved)', async () => {
    const ctx = await buildCtx('stress');
    const fromRun = describeRun(ctx);
    const fromCheckData = describeRun({
      settings: ctx.settings,
      phasePlan: ctx.phasePlan,
      context: { testType: 'stress' },
    });
    assert.deepEqual(fromCheckData, fromRun);
    assert.equal(fromRun.alarmCount, 120000);
  });
});

describe('settings Step SLA ignores (no warm-up, no events)', () => {
  it('defaults and environment values give no warning', async () => {
    const setup = await resolveStepSla('load');
    assert.deepEqual(unusedSettingWarnings(setup.resolved), []);
  });

  it('--set WARM_UP_DURATION/WARM_UP_RATE/DATASET for the run: one warning each, naming the value', async () => {
    const setup = await resolveStepSla('load', {
      WARM_UP_DURATION: '5m',
      WARM_UP_RATE: '20',
      DATASET: 'ebuzima-emr',
    });
    const warnings = unusedSettingWarnings(setup.resolved);
    assert.equal(warnings.length, 3);
    assert.ok(
      warnings.some((w) => /^WARM_UP_DURATION=.*5m.* \(cli\) is ignored: .*no warm-up/.test(w)),
    );
    assert.ok(warnings.some((w) => w.startsWith('WARM_UP_RATE=20 (cli) is ignored')));
    assert.ok(warnings.some((w) => w.startsWith('DATASET=ebuzima-emr (cli) is ignored')));
    // The phase plan really has no warm-up: the warning is true.
    assert.deepEqual(
      setup.resolved.derived.phasePlan.phases.map((phase) => phase.name),
      ['measure'],
    );
  });

  it('an environment variable counts as a per-run override; every listed name is a known setting', () => {
    const resolved = {
      values: { EVENT_SOURCE: 'x', WARM_UP_RATE: 10 },
      sources: { EVENT_SOURCE: 'env-var', WARM_UP_RATE: 'environment' },
    };
    assert.deepEqual(unusedSettingWarnings(resolved), [
      `EVENT_SOURCE=x (env-var) is ignored: ${SETTINGS_NOT_USED.EVENT_SOURCE}`,
    ]);
    const defaults = JSON.parse(
      fs.readFileSync(
        fileURLToPath(new URL('../../config/settings/defaults.json', import.meta.url)),
        'utf8',
      ),
    );
    for (const name of Object.keys(SETTINGS_NOT_USED)) assert.ok(defaults[name], name);
  });

  it('prepare() warns before it seeds', async () => {
    const ctx = await buildCtx('load', { overrides: { WARM_UP_DURATION: '5m' } });
    // No pgPool: seeding fails, but the warning must already be logged.
    await Promise.resolve()
      .then(() => stepSlaModule.prepare(ctx))
      .catch(() => {});
    assert.ok(
      ctx.logged.some(([level, m]) => level === 'warn' && m.startsWith('WARM_UP_DURATION=')),
    );
  });
});

describe('expectation (alarms/s against STEP_SLA_PEAK_ALARM_RATE)', () => {
  /** expectation() for a test type and --set overrides, with the resolved settings. */
  async function expectationOf(testType, overrides = {}) {
    const { resolved, planDefinitionSet } = await resolveStepSla(testType, overrides);
    return stepSlaModule.expectation({
      testType,
      settings: resolved.values,
      environment: loadEnvironment('local'),
      planDefinitionSet,
    });
  }

  it('load, emr-service set: 30,000 alarms at 50/s = 1 × peak 50 alarms/s', async () => {
    const e = await expectationOf('load');
    assert.equal(e.unit, 'alarms');
    assert.equal(e.targetRate, 50);
    assert.equal(e.peakRate, 50);
    assert.equal(e.multipleOfPeak, 1);
    assert.equal(e.toBeConfirmed, true);
    assert.match(e.summary, /^Handle 30,000 alarms ringing 50\/s for 10m/);
    assert.match(e.summary, /1 × peak 50 alarms\/s/);
    assert.match(e.summary, /within 10s of ringing/);
  });

  it('kenya-sha-emr-service: the peak alarm rate is PEAK_RATE × 1 DUE alarm per event = 50/s', async () => {
    const e = await expectationOf('stress', { PLAN_DEFINITION_SET: 'kenya-sha-emr-service' });
    assert.equal(e.peakRate, 50);
    assert.equal(e.targetRate, 200);
    assert.equal(e.multipleOfPeak, 4);
    assert.match(e.summary, /120,000 alarms ringing 200\/s/);
  });

  it('never the events/s PEAK_RATE: an explicit STEP_SLA_PEAK_ALARM_RATE decides "× peak"', async () => {
    const e = await expectationOf('load', { STEP_SLA_PEAK_ALARM_RATE: '100', PEAK_RATE: '7' });
    assert.equal(e.peakRate, 100);
    assert.equal(e.multipleOfPeak, 0.5);
  });

  it('storm: all at once within STEP_SLA_STORM_MAX_CATCH_UP, drain target EXPECTED_HEADROOM × peak', async () => {
    const e = await expectationOf('breakpoint');
    assert.equal(e.unit, 'alarms');
    assert.equal(e.targetRate, 200);
    assert.equal(e.peakRate, 50);
    assert.equal(e.multipleOfPeak, 4);
    assert.match(e.summary, /storm of 100,000 alarms ringing at once within 5m/);
    assert.match(e.summary, /drain ≥ 200 alarms\/s = 4 × peak 50 alarms\/s/);
  });

  it('the alarm count in the text follows a LOAD_EVENTS override (phase plan = single source)', async () => {
    const e = await expectationOf('load', { LOAD_EVENTS: '1000' });
    assert.match(e.summary, /^Handle 1,000 alarms ringing 50\/s for 20s/);
  });
});

describe('evaluate', () => {
  it('caught up (database): alarms as the unit, catch-up from the last handled, the database rule replaces the watcher rule', async () => {
    const ctx = await buildCtx('smoke');
    const evaluation = stepSlaModule.evaluate(ctx, {
      dataChecks: passingChecks({ alarms: 30 }),
      watcherOutcomes: [{ name: 'alarms', load: { eventsProcessed: 30 }, breaking: {} }],
    });
    assert.equal(evaluation.load.unit, 'alarms');
    assert.equal(evaluation.load.eventsSent, 30);
    assert.equal(evaluation.load.eventsProcessed, 30);
    assert.equal(evaluation.load.averageRate, 1);
    assert.deepEqual(evaluation.breaking, {
      rateAtBreak: 1,
      caughtUp: true,
      catchUpSeconds: 6,
      remainingBacklog: 0,
      gaveUpAfterSeconds: null,
    });
    assert.equal(evaluation.thresholds.length, 1);
    assert.equal(evaluation.thresholds[0].id, 'step-sla.caught-up');
    assert.equal(evaluation.thresholds[0].source, 'data-check');
    assert.equal(evaluation.thresholds[0].passed, true);
    assert.deepEqual(evaluation.notes, []);
  });

  it('not all handled: caughtUp false, no catch-up time, remaining alarms from the database (D19)', async () => {
    const ctx = await buildCtx('load');
    const evaluation = stepSlaModule.evaluate(ctx, {
      dataChecks: passingChecks({ alarms: 30000, handled: 29500 }),
      watcherOutcomes: [
        {
          name: 'alarms',
          load: { eventsProcessed: 29520 },
          breaking: { caughtUp: false, remainingBacklog: 480, gaveUpAfterSeconds: 120 },
        },
      ],
    });
    assert.equal(evaluation.breaking.caughtUp, false);
    assert.equal(evaluation.breaking.catchUpSeconds, null);
    assert.equal(evaluation.breaking.remainingBacklog, 500);
    assert.equal(evaluation.breaking.gaveUpAfterSeconds, 120);
    assert.equal(evaluation.thresholds[0].passed, false);
    assert.equal(evaluation.thresholds[0].actual, 500);
    // The global counters moved by more than this run's alarms: said in the notes.
    assert.ok(evaluation.notes.some((n) => /counters are global/.test(n)));
  });

  it('handled eventually but after the catch-up limit: not caught up, with a note giving the real time', async () => {
    const ctx = await buildCtx('smoke');
    const evaluation = stepSlaModule.evaluate(ctx, {
      dataChecks: passingChecks({ alarms: 30, lastHandledAfterRing: 150 }),
      watcherOutcomes: [],
    });
    assert.equal(evaluation.breaking.caughtUp, false);
    assert.equal(evaluation.breaking.catchUpSeconds, null);
    assert.ok(evaluation.notes.some((n) => /handled eventually, 2m 30s after/.test(n)));
  });

  it('storm: rateAtBreak null (all at once), averageRate null, drain note from the database', async () => {
    const ctx = await buildCtx('breakpoint');
    const checks = [
      ...passingChecks({ alarms: 100000, storm: true, lastHandledAfterRing: 69.8 }),
      {
        id: 'step-sla.storm-drain',
        description: 'drain',
        expected: null,
        actual: 1432.7,
        comparison: 'at-least',
        passed: true,
        severity: 'info',
      },
    ];
    checks[4].details.startedBreakingAt = new Date(RING).toISOString();
    const evaluation = stepSlaModule.evaluate(ctx, { dataChecks: checks, watcherOutcomes: [] });
    assert.equal(evaluation.breaking.rateAtBreak, null);
    assert.equal(evaluation.breaking.startedBreakingAt, new Date(RING).toISOString());
    assert.equal(evaluation.breaking.caughtUp, true);
    assert.equal(evaluation.breaking.catchUpSeconds, 69.8);
    assert.equal(evaluation.load.averageRate, null);
    assert.ok(evaluation.notes.some((n) => /1,432.7 alarms\/s/.test(n)));
  });

  it('reads seed.json for the notes (seed mode, pairs, warnings)', async () => {
    const ctx = await buildCtx('smoke');
    ctx.writeJson('seed.json', {
      seedMode: 'set',
      alarmCount: 30,
      pairs: new Array(4).fill({}),
      planDefinitionSet: 'kenya-sha-emr-service',
      missedSeeded: false,
      warnings: ['seeding took longer than STEP_SLA_FIRST_RING_DELAY'],
    });
    const evaluation = stepSlaModule.evaluate(ctx, { dataChecks: [], watcherOutcomes: [] });
    assert.deepEqual(evaluation.notes, [
      'Seed mode set: 30 alarms over 4 (plan definition × mandatory step) pair(s) of set kenya-sha-emr-service.',
      'Seeding: seeding took longer than STEP_SLA_FIRST_RING_DELAY',
    ]);
  });
});

describe('baselineMetrics (plan §8.3)', () => {
  it('load/stress: max and p95 wait; breakpoint: drain rate and catch-up (only when caught up); smoke: none', () => {
    const checks = passingChecks({ alarms: 30000 });
    const load = stepSlaModule.baselineMetrics({ testType: 'load', dataChecks: checks });
    assert.deepEqual(
      load.map((m) => [m.key, m.unit, m.better, m.value]),
      [
        ['step-sla.load.maxWaitSeconds', 's', 'lower', 5.1],
        ['step-sla.load.p95WaitSeconds', 's', 'lower', 4.8],
      ],
    );
    const stress = stepSlaModule.baselineMetrics({ testType: 'stress', dataChecks: checks });
    assert.deepEqual(
      stress.map((m) => m.key),
      ['step-sla.stress.maxWaitSeconds', 'step-sla.stress.p95WaitSeconds'],
    );
    const storm = stepSlaModule.baselineMetrics({
      testType: 'breakpoint',
      dataChecks: [],
      breaking: { drainRate: 1490, caughtUp: true, catchUpSeconds: 69.8 },
    });
    assert.deepEqual(
      storm.map((m) => [m.key, m.unit, m.better, m.value]),
      [
        ['step-sla.breakpoint.drainRate', 'alarms/s', 'higher', 1490],
        ['step-sla.breakpoint.catchUpSeconds', 's', 'lower', 69.8],
      ],
    );
    const notCaughtUp = stepSlaModule.baselineMetrics({
      testType: 'breakpoint',
      breaking: { drainRate: 900, caughtUp: false, catchUpSeconds: null },
    });
    assert.equal(notCaughtUp[1].value, null, 'never a number when not caught up');
    assert.deepEqual(stepSlaModule.baselineMetrics({ testType: 'smoke' }), []);
  });
});

describe('a whole seeded result.json (shared result builder)', () => {
  it('is valid: timing from the seed, load in alarms, slaCycleCapHits in the peaks, storm rateAtBreak null', async () => {
    const setup = await resolveStepSla('breakpoint');
    const ctx = await buildCtx('breakpoint');
    const environment = loadEnvironment('local');
    const context = buildRunContext({
      setup,
      module: stepSlaModule,
      testType: 'breakpoint',
      environment,
      resultsDir: { relativeDir: 'results/x', dirInContainer: '/tests/results/x' },
      apiPort: 6565,
      startedAt: RUN_START,
    });
    const prepareResult = {
      measureStart: toIsoWithOffset(new Date(RING)),
      sendEnd: toIsoWithOffset(new Date(RING)),
      plannedEvents: 100000,
      manifestFile: 'seed.json',
    };
    ctx.times.measureStart = prepareResult.measureStart;
    ctx.times.sendEnd = prepareResult.sendEnd;
    ctx.times.source = 'seed';
    const watcherOutcome = {
      name: 'alarms',
      subject: 'step-sla',
      file: path.join(ctx.resultsDir, 'watch-alarms.json'),
      samples: [],
      thresholds: [
        {
          id: 'step-sla.caught-up',
          metric: 'alarmsNotHandled',
          rule: '= 0',
          limit: 0,
          actual: 0,
          unit: 'alarms',
          passed: true,
          toBeConfirmed: false,
          source: 'watcher',
          description: 'watcher rule',
        },
      ],
      breaking: {
        caughtUp: true,
        catchUpSeconds: 70,
        remainingBacklog: 0,
        gaveUpAfterSeconds: null,
        drainRate: 1490,
      },
      load: { eventsProcessed: 100000 },
      peaks: { slaCycleCapHits: { value: 9, firstAt: toIsoWithOffset(new Date(RING + 10_000)) } },
    };
    const dataChecks = passingChecks({ alarms: 100000, storm: true, lastHandledAfterRing: 69.8 });
    const moduleEvaluation = stepSlaModule.evaluate(ctx, {
      dataChecks,
      watcherOutcomes: [watcherOutcome],
    });
    const result = buildResult({
      context,
      settings: setup.resolved,
      phasePlan: setup.resolved.derived.phasePlan,
      watcherOutcomes: [watcherOutcome],
      dataChecks,
      moduleEvaluation,
      timings: { times: ctx.times, endedAt: new Date(RING + 80_000), prepareResult },
      expectation: stepSlaModule.expectation({
        testType: 'breakpoint',
        settings: setup.resolved.values,
        environment,
      }),
      module: stepSlaModule,
    });

    assert.deepEqual(validateResult(result), []);
    assert.equal(result.status, 'passed');
    assert.equal(result.timing.source, 'seed');
    assert.equal(result.load.unit, 'alarms');
    assert.equal(result.load.plannedEvents, 100000);
    assert.equal(result.load.eventsProcessed, 100000);
    assert.equal(result.expectation.unit, 'alarms');
    assert.equal(result.breaking.drainRate, 1490);
    assert.equal(
      result.breaking.catchUpSeconds,
      69.8,
      'the database catch-up replaces the watcher estimate',
    );
    assert.equal(result.breaking.rateAtBreak, null);
    assert.equal(result.serviceMetrics.peaks['step-sla'].slaCycleCapHits.value, 9);
    assert.equal(result.artifacts.seedManifest, 'seed.json');
    assert.deepEqual(result.artifacts.watchers, ['watch-alarms.json']);
    assert.equal(result.artifacts.k6Log, null);
    const caughtUp = result.thresholds.filter((t) => t.id === 'step-sla.caught-up');
    assert.equal(caughtUp.length, 1, 'de-duplicated by id');
    assert.equal(caughtUp[0].source, 'data-check', 'the module rule wins over the watcher rule');
  });
});
