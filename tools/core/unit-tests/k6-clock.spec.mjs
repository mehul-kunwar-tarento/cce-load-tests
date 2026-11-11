/**
 * k6-clock.spec.mjs — unit tests of tools/core/k6-clock.mjs, the k6 clock contract (plan §4.7, §6.3).
 *
 * What:    With a fake GET /v1/status: "running" (true, "running" or 7) sets k6StartedAt, measureStart (warm-up
 *          excluded) and sendEnd and resolves times.ready; an API that never answers falls back to the container
 *          start ('estimated', with a warning); stop() ends polling.
 * How:     node --test tools/core/unit-tests/k6-clock.spec.mjs
 * Needs:   lib/phase-plan.js (A1) through tools/core/lib-bridge.mjs.
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPhasePlan } from '../lib-bridge.mjs';
import { createTimes, isK6Running, startK6Clock } from '../k6-clock.mjs';
import { defaultValues } from './helpers.mjs';

// Load test: warm-up 60 s, then 600 s measured.
const phasePlan = buildPhasePlan({
  testType: 'load',
  settings: defaultValues(),
  breakpointKind: 'staircase',
});

test('isK6Running accepts running:true, status "running" and status 7', () => {
  assert.equal(isK6Running({ data: { attributes: { running: true } } }), true);
  assert.equal(isK6Running({ data: { attributes: { status: 'running' } } }), true);
  assert.equal(isK6Running({ data: { attributes: { status: 7 } } }), true);
  assert.equal(isK6Running({ data: { attributes: { status: 2, running: false } } }), false);
  assert.equal(isK6Running(null), false);
});

test('running on the REST API → times from the poll moment, source k6-rest-api, ready resolved', async () => {
  const times = createTimes();
  let calls = 0;
  const t0 = Date.parse('2026-11-05T14:22:40.000+05:30');
  const getJson = async (url) => {
    assert.equal(url, 'http://127.0.0.1:6565/v1/status');
    calls += 1;
    // Not running yet on the first poll (VUs still initialising), running on the second.
    return { status: 200, body: { data: { attributes: { running: calls >= 2 } } } };
  };
  const clock = startK6Clock({
    apiUrl: 'http://127.0.0.1:6565',
    phasePlan,
    times,
    pollMs: 1,
    getJson,
    now: () => t0,
  });
  await times.ready;
  clock.stop();
  assert.equal(times.source, 'k6-rest-api');
  assert.equal(new Date(times.k6StartedAt).getTime(), t0);
  assert.equal(new Date(times.measureStart).getTime(), t0 + 60_000, 'warm-up excluded');
  assert.equal(new Date(times.sendEnd).getTime(), t0 + 660_000);
  assert.deepEqual(times.warnings, []);
  assert.ok(!('ready' in JSON.parse(JSON.stringify(times))), 'the promise is not serialised');
});

test('API never reachable for the fallback period → estimated from the container start, with a warning', async () => {
  const times = createTimes();
  const containerStartedAtMs = Date.parse('2026-11-05T14:22:33.000+05:30');
  let fakeNow = containerStartedAtMs;
  const getJson = async () => {
    fakeNow += 30_000; // every failed poll takes 30 s of fake time
    throw new Error('ECONNREFUSED');
  };
  startK6Clock({
    apiUrl: 'http://127.0.0.1:6565',
    phasePlan,
    times,
    pollMs: 1,
    getJson,
    containerStartedAtMs,
    now: () => fakeNow,
  });
  await times.ready;
  assert.equal(times.source, 'estimated');
  assert.equal(new Date(times.k6StartedAt).getTime(), containerStartedAtMs);
  assert.match(times.warnings[0], /did not answer within 60 s/);
});

test('stop() ends polling without setting times', async () => {
  const times = createTimes();
  let calls = 0;
  const clock = startK6Clock({
    apiUrl: 'http://127.0.0.1:6565',
    phasePlan,
    times,
    pollMs: 5,
    getJson: async () => (
      calls++,
      { status: 200, body: { data: { attributes: { running: false } } } }
    ),
  });
  await new Promise((r) => setTimeout(r, 20));
  clock.stop();
  const seen = calls;
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(calls <= seen + 1);
  assert.equal(times.source, null);
});
