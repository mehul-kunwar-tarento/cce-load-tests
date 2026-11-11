/**
 * phase-plan.spec.mjs — unit tests of lib/phase-plan.js (every row of plan §4.1)
 *
 * What:    Builds the phase plan of every test type and breakpoint kind (staircase, flood, none =
 *          Step SLA) from pre-derived numeric settings and checks phases, planned events and windows.
 * How:     node --test lib/unit-tests/
 * Needs:   Node.js 22; settings-fixture.mjs.
 * Outputs: Test results on stdout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPhasePlan, phaseAt, plannedSentBy, measuredPhaseOf } from '../phase-plan.js';
import { settingsWith } from './settings-fixture.mjs';

test('smoke: one smoke phase, no warm-up, measured phase "smoke"', () => {
  const plan = buildPhasePlan({ testType: 'smoke', settings: settingsWith() });
  assert.deepEqual(plan.phases, [
    {
      name: 'smoke',
      kind: 'constant',
      rate: 1,
      startSeconds: 0,
      durationSeconds: 30,
      plannedEvents: 30,
    },
  ]);
  assert.equal(plan.measuredPhase, 'smoke');
  assert.equal(plan.plannedMeasuredEvents, 30);
  assert.equal(plan.totalSeconds, 30);
  assert.equal(plan.windowSeconds, 10);
  assert.equal(plan.windowCount, 3);
});

test('load: warm-up 1m at 10/s then 10m at 50/s', () => {
  const plan = buildPhasePlan({ testType: 'load', settings: settingsWith() });
  assert.deepEqual(
    plan.phases.map((p) => [p.name, p.rate, p.startSeconds, p.durationSeconds, p.plannedEvents]),
    [
      ['warm-up', 10, 0, 60, 600],
      ['measure', 50, 60, 600, 30000],
    ],
  );
  assert.equal(plan.measuredPhase, 'measure');
  assert.equal(plan.plannedEvents, 30600);
  assert.equal(plan.plannedMeasuredEvents, 30000);
  assert.equal(plan.totalSeconds, 660);
  assert.equal(plan.windowCount, 60);
});

test('load with a pre-derived LOAD_DURATION (as if LOAD_EVENTS=1000) plans exactly 1000 measured events', () => {
  // settings.mjs (A2) turns LOAD_EVENTS=1000 at 50/s into LOAD_DURATION=20; the plan never derives it.
  const plan = buildPhasePlan({
    testType: 'load',
    settings: settingsWith({ LOAD_DURATION: 20, LOAD_EVENTS: 1000 }),
  });
  assert.equal(plan.plannedMeasuredEvents, 1000);
  assert.equal(measuredPhaseOf(plan).durationSeconds, 20);
});

test('WARM_UP_DURATION 0 removes the warm-up phase', () => {
  const plan = buildPhasePlan({
    testType: 'stress',
    settings: settingsWith({ WARM_UP_DURATION: 0 }),
  });
  assert.deepEqual(
    plan.phases.map((p) => p.name),
    ['measure'],
  );
  assert.equal(plan.phases[0].startSeconds, 0);
  assert.equal(plan.plannedEvents, 120000);
});

test('stress: 200/s for 10m after warm-up', () => {
  const plan = buildPhasePlan({ testType: 'stress', settings: settingsWith() });
  assert.equal(measuredPhaseOf(plan).rate, 200);
  assert.equal(plan.plannedMeasuredEvents, 120000);
});

test('breakpoint staircase: levels 200..6400, 1m each, absolute start times', () => {
  const plan = buildPhasePlan({
    testType: 'breakpoint',
    settings: settingsWith(),
    breakpointKind: 'staircase',
  });
  const measure = measuredPhaseOf(plan);
  assert.equal(measure.kind, 'staircase');
  assert.equal(measure.rate, 6400);
  assert.equal(measure.startSeconds, 60);
  assert.equal(measure.durationSeconds, 360);
  assert.deepEqual(
    measure.levels.map((l) => [l.rate, l.startSeconds, l.plannedEvents]),
    [
      [200, 60, 12000],
      [400, 120, 24000],
      [800, 180, 48000],
      [1600, 240, 96000],
      [3200, 300, 192000],
      [6400, 360, 384000],
    ],
  );
  assert.equal(plan.plannedMeasuredEvents, 756000);
  assert.equal(plan.windowCount, 36);
});

test('breakpoint staircase refines with warm-up at the last good level (runner sets WARM_UP_RATE and LEVELS)', () => {
  const plan = buildPhasePlan({
    testType: 'breakpoint',
    settings: settingsWith({ WARM_UP_RATE: 1600, LEVELS: [1600, 2000, 2400, 2800] }),
  });
  assert.equal(plan.phases[0].rate, 1600);
  assert.deepEqual(
    measuredPhaseOf(plan).levels.map((l) => l.rate),
    [1600, 2000, 2400, 2800],
  );
});

test('breakpoint flood: warm-up then 2000/s for 1m', () => {
  const plan = buildPhasePlan({
    testType: 'breakpoint',
    settings: settingsWith(),
    breakpointKind: 'flood',
  });
  assert.deepEqual(
    plan.phases.map((p) => [p.name, p.kind, p.rate, p.durationSeconds]),
    [
      ['warm-up', 'constant', 10, 60],
      ['measure', 'constant', 2000, 60],
    ],
  );
  assert.equal(plan.plannedMeasuredEvents, 120000);
  assert.equal(plan.windowCount, 6);
});

test('flood smoke/load/stress behave like any k6 test', () => {
  const plan = buildPhasePlan({
    testType: 'smoke',
    settings: settingsWith(),
    breakpointKind: 'flood',
  });
  assert.equal(plan.measuredPhase, 'smoke');
});

test('Step SLA (none) smoke/load/stress: one measure phase starting at the first ring delay', () => {
  const settings = settingsWith();
  const expected = { smoke: [1, 30, 30], load: [50, 600, 30000], stress: [200, 600, 120000] };
  for (const [testType, [rate, duration, alarms]] of Object.entries(expected)) {
    const plan = buildPhasePlan({ testType, settings, breakpointKind: 'none' });
    assert.equal(plan.phases.length, 1, testType);
    assert.deepEqual(plan.phases[0], {
      name: 'measure',
      kind: 'constant',
      rate,
      startSeconds: 60,
      durationSeconds: duration,
      plannedEvents: alarms,
    });
    assert.equal(plan.measuredPhase, 'measure');
    assert.equal(
      plan.plannedMeasuredEvents,
      alarms,
      `${testType}: alarm count comes from the plan`,
    );
    assert.equal(plan.totalSeconds, 60 + duration);
  }
});

test('Step SLA storm: rate 0, duration 0, all alarms at once; windows cover the catch-up limit', () => {
  const plan = buildPhasePlan({
    testType: 'breakpoint',
    settings: settingsWith(),
    breakpointKind: 'none',
  });
  assert.deepEqual(plan.phases, [
    {
      name: 'measure',
      kind: 'constant',
      rate: 0,
      startSeconds: 60,
      durationSeconds: 0,
      plannedEvents: 100000,
    },
  ]);
  assert.equal(plan.plannedMeasuredEvents, 100000);
  assert.equal(plan.windowSeconds, 10);
  assert.equal(plan.windowCount, 90);
});

test('windows widen to keep at most 200', () => {
  const plan = buildPhasePlan({
    testType: 'load',
    settings: settingsWith({ LOAD_DURATION: 4 * 3600 }),
  });
  assert.equal(plan.windowSeconds, 72);
  assert.equal(plan.windowCount, 200);
  const odd = buildPhasePlan({ testType: 'load', settings: settingsWith({ LOAD_DURATION: 25 }) });
  assert.equal(odd.windowCount, 3); // last window is 5 s long
});

test('typed-settings guard: strings and missing values are refused with the setting name', () => {
  assert.throws(
    () => buildPhasePlan({ testType: 'load', settings: settingsWith({ LOAD_DURATION: '10m' }) }),
    /LOAD_DURATION/,
  );
  assert.throws(
    () => buildPhasePlan({ testType: 'load', settings: settingsWith({ LOAD_RATE: null }) }),
    /LOAD_RATE/,
  );
  assert.throws(
    () => buildPhasePlan({ testType: 'load', settings: settingsWith({ LOAD_DURATION: 0 }) }),
    /LOAD_DURATION/,
  );
  assert.throws(
    () => buildPhasePlan({ testType: 'breakpoint', settings: settingsWith({ LEVELS: '200,400' }) }),
    /LEVELS/,
  );
  assert.throws(
    () =>
      buildPhasePlan({ testType: 'breakpoint', settings: settingsWith({ LEVELS: [400, 200] }) }),
    /ascending/,
  );
  assert.throws(
    () => buildPhasePlan({ testType: 'breakpoint', settings: settingsWith({ LEVEL_DURATION: 1 }) }),
    /LEVEL_DURATION/,
  );
  assert.throws(
    () => buildPhasePlan({ testType: 'soak', settings: settingsWith() }),
    /Unknown test type/,
  );
  assert.throws(
    () => buildPhasePlan({ testType: 'load', settings: settingsWith(), breakpointKind: 'x' }),
    /breakpoint kind/,
  );
});

test('phaseAt finds phase and level; plannedSentBy follows the schedule', () => {
  const plan = buildPhasePlan({ testType: 'breakpoint', settings: settingsWith() });
  assert.equal(phaseAt(plan, 0).phase.name, 'warm-up');
  assert.equal(phaseAt(plan, 59.9).phaseIndex, 0);
  const at = phaseAt(plan, 130);
  assert.equal(at.phase.name, 'measure');
  assert.equal(at.phaseIndex, 1);
  assert.equal(at.level.rate, 400);
  assert.deepEqual(phaseAt(plan, 420), { phase: null, phaseIndex: -1, level: null });

  assert.equal(plannedSentBy(plan, 0), 0);
  assert.equal(plannedSentBy(plan, 30), 300);
  assert.equal(plannedSentBy(plan, 60), 600);
  assert.equal(plannedSentBy(plan, 130), 600 + 12000 + 4000);
  assert.equal(plannedSentBy(plan, 10000), plan.plannedEvents);

  const storm = buildPhasePlan({
    testType: 'breakpoint',
    settings: settingsWith(),
    breakpointKind: 'none',
  });
  assert.equal(plannedSentBy(storm, 59), 0);
  assert.equal(plannedSentBy(storm, 60), 100000);
});

test('event totals: fractional durations plan exactly the requested events (no rounding up)', () => {
  // LOAD_EVENTS=1001 at 50/s → 20.02 s; LOAD_EVENTS=1001 at 3/s → 333.666667 s (microsecond-rounded).
  const at50 = buildPhasePlan({
    testType: 'load',
    settings: settingsWith({ WARM_UP_DURATION: 0, LOAD_DURATION: 1001 / 50 }),
  });
  assert.equal(at50.plannedMeasuredEvents, 1001);
  const at3 = buildPhasePlan({
    testType: 'load',
    settings: settingsWith({ WARM_UP_DURATION: 0, LOAD_RATE: 3, LOAD_DURATION: 333.666667 }),
  });
  assert.equal(at3.plannedMeasuredEvents, 1001);
  assert.equal(plannedSentBy(at50, 1000), 1001);
});

test('k6 phases shorter than 1 s are refused with the setting name (k6 minimum)', () => {
  // MATCHER_FLOOD_EVENTS=1001 at 2,000/s would be 0.5005 s: cannot be sent at that rate.
  assert.throws(
    () =>
      buildPhasePlan({
        testType: 'breakpoint',
        breakpointKind: 'flood',
        settings: settingsWith({ MATCHER_FLOOD_DURATION: 1001 / 2000 }),
      }),
    /MATCHER_FLOOD_DURATION must be at least 1s \(k6 minimum\)/,
  );
  assert.throws(
    () => buildPhasePlan({ testType: 'smoke', settings: settingsWith({ SMOKE_DURATION: 0.5 }) }),
    /SMOKE_DURATION must be at least 1s/,
  );
  assert.throws(
    () => buildPhasePlan({ testType: 'load', settings: settingsWith({ WARM_UP_DURATION: 0.5 }) }),
    /WARM_UP_DURATION must be at least 1s/,
  );
  // Step SLA is seeded, not k6: a short ring schedule stays allowed.
  const seeded = buildPhasePlan({
    testType: 'load',
    breakpointKind: 'none',
    settings: settingsWith({ LOAD_DURATION: 0.5 }),
  });
  assert.equal(seeded.plannedMeasuredEvents, 25);
});
