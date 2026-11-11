/**
 * scenarios.spec.mjs — unit tests of lib/scenarios.js (plan §4.3)
 *
 * What:    Checks executors, start times, staircase stages and the VU formulas (HTTP staircase 200..6400
 *          → 100/2000; Kafka flood 2000/s → 100/500; Kafka smoke 1/s → 2/4), tags and summary stats.
 * How:     node --test lib/unit-tests/
 * Needs:   Node.js 22; settings-fixture.mjs.
 * Outputs: Test results on stdout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPhasePlan } from '../phase-plan.js';
import {
  buildScenarios,
  buildOptions,
  vusFor,
  k6ConstantSeconds,
  SUMMARY_TREND_STATS,
} from '../scenarios.js';
import { settingsWith } from './settings-fixture.mjs';

/** A run context like run-context.json (plan §3.5) for one test. */
function contextFor(testType, breakpointKind = 'staircase', changes = {}) {
  const settings = settingsWith(changes);
  return {
    runId: '20261105-142233',
    subject: 'collector',
    testType,
    environment: { name: 'local', kind: 'local' },
    planDefinitionSet: { name: 'overlapping-4', fanOut: 4 },
    settings,
    phasePlan: buildPhasePlan({ testType, settings, breakpointKind }),
  };
}

test('HTTP VU formula', () => {
  assert.deepEqual(vusFor(50, { kind: 'http', maxVus: 2000 }), {
    preAllocatedVUs: 25,
    maxVUs: 200,
  });
  assert.deepEqual(vusFor(1, { kind: 'http', maxVus: 2000 }), { preAllocatedVUs: 2, maxVUs: 50 });
  assert.deepEqual(vusFor(200, { kind: 'http', maxVus: 2000 }), {
    preAllocatedVUs: 100,
    maxVUs: 800,
  });
  assert.deepEqual(vusFor(6400, { kind: 'http', maxVus: 2000 }), {
    preAllocatedVUs: 2000,
    maxVUs: 2000,
  });
  assert.deepEqual(vusFor(50, { kind: 'http', maxVus: 20 }), { preAllocatedVUs: 20, maxVUs: 20 });
});

test('Kafka VU formula never uses MAX_VUS', () => {
  const limits = { kind: 'kafka', maxVus: 3, kafkaPreAllocatedVus: 100, kafkaMaxVus: 500 };
  assert.deepEqual(vusFor(2000, limits), { preAllocatedVUs: 100, maxVUs: 500 });
  assert.deepEqual(vusFor(1, limits), { preAllocatedVUs: 2, maxVUs: 4 });
  assert.deepEqual(vusFor(50, limits), { preAllocatedVUs: 25, maxVUs: 200 });
});

test('load: constant-arrival-rate per phase, start times from the plan', () => {
  const scenarios = buildScenarios(contextFor('load').phasePlan, { kind: 'http', maxVus: 2000 });
  assert.deepEqual(Object.keys(scenarios), ['warm-up', 'measure']);
  assert.deepEqual(scenarios.measure, {
    executor: 'constant-arrival-rate',
    rate: 50,
    duration: '600s',
    timeUnit: '1s',
    startTime: '60s',
    exec: 'default',
    tags: { phase: 'measure' },
    preAllocatedVUs: 25,
    maxVUs: 200,
  });
  assert.equal(scenarios['warm-up'].startTime, '0s');
  assert.equal(scenarios['warm-up'].rate, 10);
});

test('smoke has a single scenario named smoke', () => {
  const scenarios = buildScenarios(contextFor('smoke').phasePlan, { kind: 'http', maxVus: 2000 });
  assert.deepEqual(Object.keys(scenarios), ['smoke']);
  assert.equal(scenarios.smoke.duration, '30s');
});

test('staircase: ramping-arrival-rate, 1 s jump + hold per level, VUs from first and top level', () => {
  const scenario = buildScenarios(contextFor('breakpoint').phasePlan, {
    kind: 'http',
    maxVus: 2000,
  }).measure;
  assert.equal(scenario.executor, 'ramping-arrival-rate');
  assert.equal(scenario.startRate, 200);
  assert.equal(scenario.startTime, '60s');
  assert.deepEqual(scenario.stages.slice(0, 4), [
    { duration: '1s', target: 200 },
    { duration: '59s', target: 200 },
    { duration: '1s', target: 400 },
    { duration: '59s', target: 400 },
  ]);
  assert.equal(scenario.stages.length, 12);
  assert.equal(scenario.preAllocatedVUs, 100);
  assert.equal(scenario.maxVUs, 2000);
});

test('Kafka flood and Kafka smoke VUs (v1 values)', () => {
  const flood = buildOptions({ context: contextFor('breakpoint', 'flood'), kind: 'kafka' })
    .scenarios.measure;
  assert.equal(flood.rate, 2000);
  assert.equal(flood.preAllocatedVUs, 100);
  assert.equal(flood.maxVUs, 500);
  const smoke = buildOptions({ context: contextFor('smoke', 'flood'), kind: 'kafka' }).scenarios
    .smoke;
  assert.equal(smoke.preAllocatedVUs, 2);
  assert.equal(smoke.maxVUs, 4);
});

test('buildOptions: tags, summary stats, thresholds and connection reuse', () => {
  const options = buildOptions({ context: contextFor('load'), kind: 'http' });
  assert.deepEqual(options.tags, {
    testid: '20261105-142233',
    service: 'collector',
    test_type: 'load',
    plan_definition_set: 'overlapping-4',
    environment: 'local',
  });
  assert.deepEqual(options.summaryTrendStats, SUMMARY_TREND_STATS);
  assert.deepEqual(SUMMARY_TREND_STATS, ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)']);
  assert.deepEqual(options.thresholds.dropped_iterations, ['count<=30']);
  assert.equal(options.noConnectionReuse, false);
  // Every executor is an arrival-rate one (open model, D4).
  for (const scenario of Object.values(options.scenarios))
    assert.match(scenario.executor, /arrival-rate$/);
});

test('buildOptions refuses a missing context and Step SLA plans', () => {
  assert.throws(() => buildOptions({ context: null, kind: 'http' }), /run context/);
  assert.throws(
    () => buildOptions({ context: contextFor('load', 'none'), kind: 'http' }),
    /seeded/,
  );
});

test('event total: a fractional duration stops k6 half a gap before the next event (exact count)', () => {
  // LOAD_EVENTS=1001 at 50/s → LOAD_DURATION 20.02 s (derived by Node): exactly 1,001 planned and sent.
  const plan = buildPhasePlan({
    testType: 'load',
    settings: settingsWith({ WARM_UP_DURATION: 0, LOAD_DURATION: 1001 / 50 }),
  });
  assert.equal(plan.plannedMeasuredEvents, 1001);
  const scenarios = buildScenarios(plan);
  assert.equal(scenarios.measure.duration, '20010ms');
  // k6 starts events at i / rate while t < duration: i = 0 … 1000 → 1,001 events.
  const k6Seconds = k6ConstantSeconds(plan.phases[0]);
  assert.equal(Math.ceil(k6Seconds * 50), 1001);
  // Whole-second durations are left as they are (600 s at 50/s = 30,000).
  assert.equal(k6ConstantSeconds({ rate: 50, durationSeconds: 600, plannedEvents: 30000 }), 600);
});

test('event total at a high rate: microsecond k6 duration, still exact', () => {
  // MATCHER_FLOOD_EVENTS=3001 at 2,000/s → 1.5005 s; k6 duration (3001 − 0.5) / 2000 = 1.50025 s.
  const plan = buildPhasePlan({
    testType: 'breakpoint',
    breakpointKind: 'flood',
    settings: settingsWith({ WARM_UP_DURATION: 0, MATCHER_FLOOD_DURATION: 3001 / 2000 }),
  });
  assert.equal(plan.plannedMeasuredEvents, 3001);
  assert.equal(
    buildScenarios(plan, { kind: 'kafka', kafkaPreAllocatedVus: 2, kafkaMaxVus: 8 }).measure
      .duration,
    '1500250us',
  );
});

test('an event total equal to the rate is exactly 1 s (k6 minimum)', () => {
  assert.equal(k6ConstantSeconds({ rate: 2000, durationSeconds: 1, plannedEvents: 2000 }), 1);
  assert.equal(k6ConstantSeconds({ rate: 3, durationSeconds: 1.0000003, plannedEvents: 3 }), 1);
});
