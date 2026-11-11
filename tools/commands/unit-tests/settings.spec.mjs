/**
 * settings.spec.mjs — unit tests of tools/commands/settings.mjs (the `settings` command).
 *
 * What:    Spec R9 with the stub module (LOAD_EVENTS=1000 → LOAD_DURATION 20s derived, phase plan printed);
 *          without a subject only values (no phase plan, every setting); --json output; refusals (prod,
 *          unknown setting, wrong arity, unknown test type). Never connects (D14).
 * How:     node --test tools/commands/unit-tests/settings.spec.mjs
 * Needs:   config/, the stub module (tools/core/unit-tests/fixtures/stub-service/).
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RefusedError, UsageError } from '../../core/errors.mjs';
import { sink } from '../../core/unit-tests/helpers.mjs';
import { main } from '../settings.mjs';

const MODULES_ROOT = new URL('../../core/unit-tests/fixtures', import.meta.url).pathname;
const run = async (argv, deps = {}) => {
  const out = sink();
  const code = await main(
    argv,
    { stdout: out },
    { env: {}, now: new Date('2026-11-05T14:22:33'), ...deps },
  );
  return { code, text: out.text };
};

test('R9 with the stub: LOAD_EVENTS=1000 → LOAD_DURATION 20s (derived), measured phase 1,000 events', async () => {
  const { code, text } = await run([
    'local',
    'stub',
    'load',
    '--set',
    'LOAD_EVENTS=1000',
    '--modules-root',
    MODULES_ROOT,
  ]);
  assert.equal(code, 0);
  assert.match(text, /\| LOAD_DURATION \| 20s \| derived \|/);
  assert.match(text, /\| LOAD_EVENTS \| 1,000 \| cli \|/);
  assert.match(text, /\| measure \| constant \| 50\/s \| 1m 0s \| 20s \| 1,000 \|/);
  assert.match(text, /\| warm-up \| constant \| 10\/s \| 0s \| 1m 0s \| 600 \|/);
});

test('without a subject: values only, every setting, no phase plan', async () => {
  const { code, text } = await run(['local']);
  assert.equal(code, 0);
  assert.match(text, /no subject: values only/);
  assert.match(text, /\| CLEANUP_BATCH_SIZE \| 10,000 \| default \|/);
  assert.match(text, /\| RUN_ID \| 20261105-142233 \| derived \|/);
  assert.doesNotMatch(text, /\| Phase \|/);
});

test('--json: settings with value and source, derived phase plan, warnings', async () => {
  const { text } = await run([
    'local',
    'stub',
    'stress',
    '--json',
    '--set',
    'STRESS_EVENTS=400',
    '--set',
    'STRESS_DURATION=1m',
    '--modules-root',
    MODULES_ROOT,
  ]);
  const json = JSON.parse(text);
  assert.deepEqual(json.settings.STRESS_DURATION, { value: 2, source: 'derived' });
  assert.equal(json.derived.phasePlan.plannedMeasuredEvents, 400);
  assert.match(json.warnings.join(), /STRESS_EVENTS wins/);
});

test('env vars count as a source (no --set needed)', async () => {
  const { text } = await run(['local', 'stub', 'load', '--modules-root', MODULES_ROOT], {
    env: { LOAD_RATE: '25' },
  });
  assert.match(text, /\| LOAD_RATE \| 25 \| env-var \|/);
});

test('refusals: prod, unknown setting, wrong arity, unknown test type', async () => {
  await assert.rejects(run(['prod']), RefusedError);
  await assert.rejects(run(['local', '--set', 'LOAD_RAT=1']), /Unknown setting/);
  await assert.rejects(run(['local', 'stub']), UsageError);
  await assert.rejects(
    run(['local', 'stub', 'soak', '--modules-root', MODULES_ROOT]),
    /has no soak test/,
  );
});
