/**
 * staircase.spec.mjs — unit tests of tools/core/staircase.mjs (plan §6.2 --refine-from, §6.9).
 *
 * What:    Fine levels between "held" and "broke" (400/800 → 500, 600, 700), the step rule, and the overrides
 *          of a refined run (LEVELS + WARM_UP_RATE = the last good level, so it does not start cold).
 * How:     node --test tools/core/unit-tests/staircase.spec.mjs
 * Needs:   Nothing.
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RefusedError } from '../errors.mjs';
import { computeFineLevels, refineFromResult } from '../staircase.mjs';

test('computeFineLevels: step = max(50, floor((bad-good)/4/50)*50), strictly between', () => {
  assert.deepEqual(computeFineLevels(400, 800), [500, 600, 700]);
  assert.deepEqual(computeFineLevels(1600, 3200), [2000, 2400, 2800]);
  assert.deepEqual(computeFineLevels(200, 300), [250]);
  assert.deepEqual(computeFineLevels(200, 250), []);
  assert.throws(() => computeFineLevels(800, 400), RefusedError);
});

test('refineFromResult: LEVELS between held and broke, warm-up at the held level', () => {
  const refine = refineFromResult({
    runId: 'r1',
    testType: 'breakpoint',
    breaking: { heldUpTo: 400, brokeAtRate: 800 },
  });
  assert.deepEqual(refine, {
    LEVELS: '500,600,700',
    WARM_UP_RATE: '400',
    refinedFrom: { runId: 'r1', heldUpTo: 400, brokeAtRate: 800 },
  });
});

test('refineFromResult refuses non-breakpoint results and runs that never held or never broke', () => {
  assert.throws(() => refineFromResult({ testType: 'load', breaking: {} }), /breakpoint result/);
  assert.throws(
    () =>
      refineFromResult({ testType: 'breakpoint', breaking: { heldUpTo: null, brokeAtRate: 200 } }),
    /held no level/,
  );
  assert.throws(
    () =>
      refineFromResult({ testType: 'breakpoint', breaking: { heldUpTo: 6400, brokeAtRate: null } }),
    /never broke/,
  );
});
