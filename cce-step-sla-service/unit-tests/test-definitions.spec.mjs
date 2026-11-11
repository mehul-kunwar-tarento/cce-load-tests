/**
 * test-definitions.spec.mjs — unit tests of the four Step SLA test definitions (tests/step-sla-*.test.mjs).
 *
 * What:    Proves that describe() reads the alarm count and ring rate from the phase plan (the single source,
 *          plan §4.1/§6.7) and only adds the wait and catch-up limits: the defaults (smoke 30 at 1/s, load
 *          30,000 at 50/s, stress 120,000 at 200/s, storm 100,000 at once), a LOAD_EVENTS override already
 *          turned into a duration by the settings resolver, wrong phase plans refused, no import side effects.
 * How:     npm test   (or: node --test cce-step-sla-service/unit-tests/test-definitions.spec.mjs)
 * Needs:   config/ and test-data/ of the repository (files only); no network.
 * Outputs: node:test results.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import breakpointTest from '../tests/step-sla-breakpoint.test.mjs';
import loadTest from '../tests/step-sla-load.test.mjs';
import smokeTest from '../tests/step-sla-smoke.test.mjs';
import stressTest from '../tests/step-sla-stress.test.mjs';
import { defineStepSlaTest } from '../tests/step-sla-test-definition.mjs';
import { resolveStepSla } from './helpers.mjs';

const DEFINITIONS = {
  smoke: smokeTest,
  load: loadTest,
  stress: stressTest,
  breakpoint: breakpointTest,
};

describe('Step SLA test definitions', () => {
  it('each file exports its own test type and only describe()', () => {
    for (const [type, definition] of Object.entries(DEFINITIONS)) {
      assert.equal(definition.testType, type);
      assert.deepEqual(Object.keys(definition).sort(), ['describe', 'testType']);
    }
  });

  it('defaults: smoke 30 at 1/s, load 30,000 at 50/s, stress 120,000 at 200/s, storm 100,000 at once', async () => {
    const expected = {
      smoke: { alarmCount: 30, ratePerSecond: 1, maxWaitSeconds: 10, catchUpLimitSeconds: 120 },
      load: { alarmCount: 30000, ratePerSecond: 50, maxWaitSeconds: 10, catchUpLimitSeconds: 120 },
      stress: {
        alarmCount: 120000,
        ratePerSecond: 200,
        maxWaitSeconds: 10,
        catchUpLimitSeconds: 120,
      },
      breakpoint: {
        alarmCount: 100000,
        ratePerSecond: 0,
        maxWaitSeconds: 300,
        catchUpLimitSeconds: 900,
      },
    };
    for (const [type, definition] of Object.entries(DEFINITIONS)) {
      const { resolved } = await resolveStepSla(type);
      // Exactly these four fields: the definition adds only the limits to the phase-plan numbers.
      assert.deepEqual(definition.describe(resolved), expected[type], type);
    }
  });

  it('alarmCount always equals phasePlan.plannedMeasuredEvents and the rate the measured phase rate', async () => {
    for (const [type, definition] of Object.entries(DEFINITIONS)) {
      const { resolved } = await resolveStepSla(type, {
        STEP_SLA_STORM_ALARMS: '2500',
        SMOKE_RATE: '3',
      });
      const plan = resolved.derived.phasePlan;
      const measured = plan.phases.find((p) => p.name === plan.measuredPhase);
      const described = definition.describe(resolved);
      assert.equal(described.alarmCount, plan.plannedMeasuredEvents, type);
      assert.equal(described.ratePerSecond, measured.rate, type);
    }
  });

  it('LOAD_EVENTS (derived into LOAD_DURATION by the settings resolver) sets the alarm count', async () => {
    const { resolved } = await resolveStepSla('load', { LOAD_EVENTS: '1000' });
    assert.equal(resolved.values.LOAD_DURATION, 20); // ceil(1000 / 50)
    assert.equal(resolved.sources.LOAD_DURATION, 'derived');
    const described = loadTest.describe(resolved);
    assert.equal(described.alarmCount, 1000);
    assert.equal(described.alarmCount, resolved.derived.phasePlan.plannedMeasuredEvents);
  });

  it('STEP_SLA_MAX_WAIT=auto follows the poll interval; an explicit value wins', async () => {
    const auto = await resolveStepSla('load');
    assert.equal(loadTest.describe(auto.resolved).maxWaitSeconds, 10); // 2 × 5 s (local.json)
    const explicit = await resolveStepSla('load', { STEP_SLA_MAX_WAIT: '30s' });
    assert.equal(loadTest.describe(explicit.resolved).maxWaitSeconds, 30);
  });

  it('refuses a phase plan of another test type or a k6 breakpoint kind', async () => {
    const { resolved } = await resolveStepSla('load');
    assert.throws(() => stressTest.describe(resolved), /not step-sla stress/);
    const k6Like = {
      ...resolved,
      derived: {
        ...resolved.derived,
        phasePlan: { ...resolved.derived.phasePlan, breakpointKind: 'staircase' },
      },
    };
    assert.throws(() => loadTest.describe(k6Like), /not step-sla load\/none/);
    assert.throws(
      () => loadTest.describe({ values: {}, derived: { phasePlan: null } }),
      /needs the phase plan/,
    );
  });

  it('refuses an unresolved STEP_SLA_MAX_WAIT with a hint', async () => {
    const { resolved } = await resolveStepSla('smoke');
    const unresolved = { ...resolved, values: { ...resolved.values, STEP_SLA_MAX_WAIT: null } };
    assert.throws(() => smokeTest.describe(unresolved), /STEP_SLA_MAX_WAIT could not be resolved/);
  });

  it('defineStepSlaTest refuses an unknown type', () => {
    assert.throws(() => defineStepSlaTest('soak'), /Unknown Step SLA test type/);
  });
});
