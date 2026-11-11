/**
 * windows.spec.mjs — unit tests of lib/windows.js
 *
 * What:    Checks window indexes, staircase levels and window bounds for load, staircase and storm plans.
 * How:     node --test lib/unit-tests/
 * Needs:   Node.js 22; settings-fixture.mjs.
 * Outputs: Test results on stdout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPhasePlan } from '../phase-plan.js';
import { windowIndexAt, levelAt, windowBounds, windowCoverSeconds } from '../windows.js';
import { settingsWith } from './settings-fixture.mjs';

test('windowIndexAt is null outside the measured phase', () => {
  const plan = buildPhasePlan({ testType: 'load', settings: settingsWith() });
  assert.equal(windowIndexAt(plan, 30), null); // warm-up
  assert.equal(windowIndexAt(plan, 60), 0);
  assert.equal(windowIndexAt(plan, 69.99), 0);
  assert.equal(windowIndexAt(plan, 70), 1);
  assert.equal(windowIndexAt(plan, 659.9), 59);
  assert.equal(windowIndexAt(plan, 660), null);
});

test('last window may be short but is still the last window', () => {
  const plan = buildPhasePlan({
    testType: 'load',
    settings: settingsWith({ LOAD_DURATION: 25, WARM_UP_DURATION: 0 }),
  });
  assert.equal(windowIndexAt(plan, 24), 2);
  assert.deepEqual(windowBounds(plan, 2), {
    startSeconds: 20,
    endSeconds: 25,
    absoluteStartSeconds: 20,
    absoluteEndSeconds: 25,
  });
});

test('levelAt follows the staircase and is null elsewhere', () => {
  const plan = buildPhasePlan({ testType: 'breakpoint', settings: settingsWith() });
  assert.equal(levelAt(plan, 30), null);
  assert.equal(levelAt(plan, 60), 200);
  assert.equal(levelAt(plan, 179.9), 400);
  assert.equal(levelAt(plan, 419), 6400);
  assert.equal(levelAt(plan, 420), null);
  const load = buildPhasePlan({ testType: 'load', settings: settingsWith() });
  assert.equal(levelAt(load, 100), null);
});

test('windowBounds gives measure-relative and absolute seconds', () => {
  const plan = buildPhasePlan({ testType: 'load', settings: settingsWith() });
  assert.deepEqual(windowBounds(plan, 3), {
    startSeconds: 30,
    endSeconds: 40,
    absoluteStartSeconds: 90,
    absoluteEndSeconds: 100,
  });
  assert.throws(() => windowBounds(plan, 60), /does not exist/);
});

test('storm windows cover the catch-up period after the ring moment', () => {
  const plan = buildPhasePlan({
    testType: 'breakpoint',
    settings: settingsWith(),
    breakpointKind: 'none',
  });
  assert.equal(windowCoverSeconds(plan), 900);
  assert.equal(windowIndexAt(plan, 60), 0);
  assert.equal(windowIndexAt(plan, 959), 89);
  assert.equal(windowIndexAt(plan, 960), null);
});
