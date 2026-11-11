/**
 * thresholds.spec.mjs — unit tests of lib/thresholds.js (every rule of plan §4.2)
 *
 * What:    Checks the dropped-iterations allowance (D9), the rules per test type and kind (HTTP, Kafka,
 *          staircase), the warm-up abort rule, the dummy summary rules and the plain-words descriptions.
 * How:     node --test lib/unit-tests/
 * Needs:   Node.js 22; settings-fixture.mjs.
 * Outputs: Test results on stdout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPhasePlan } from '../phase-plan.js';
import { allowedDropped, buildThresholds, describeThreshold, isDummyRule } from '../thresholds.js';
import { settingsWith } from './settings-fixture.mjs';

/** Builds the thresholds of one test with default settings plus changes. */
function thresholdsFor(testType, kind, { breakpointKind = 'staircase', changes = {} } = {}) {
  const settings = settingsWith(changes);
  const phasePlan = buildPhasePlan({ testType, settings, breakpointKind });
  return buildThresholds({ phasePlan, settings, kind });
}

test('allowedDropped = floor(planned × rate)', () => {
  assert.equal(allowedDropped(30000, 0.001), 30);
  assert.equal(allowedDropped(30600, 0.001), 30);
  assert.equal(allowedDropped(120600, 0.001), 120);
  assert.equal(allowedDropped(30, 0.001), 0);
  assert.equal(allowedDropped(1000, 0), 0);
});

test('isDummyRule recognises only the summary-forcing rules', () => {
  for (const rule of ['count>=0', 'p(95)>=0', 'rate>=0', 'count >= 0', { threshold: 'rate>=0' }]) {
    assert.equal(isDummyRule(rule), true, JSON.stringify(rule));
  }
  for (const rule of [
    'count>=1',
    'p(95)<500',
    'rate<0.01',
    'count<=30',
    { threshold: 'rate>0.99', abortOnFail: true },
    null,
  ]) {
    assert.equal(isDummyRule(rule), false, JSON.stringify(rule));
  }
});

test('http load: measured-scenario rules, dropped allowance over all phases, warm-up abort', () => {
  const t = thresholdsFor('load', 'http');
  assert.deepEqual(t['http_req_duration{scenario:measure}'], ['p(95)<500']);
  assert.deepEqual(t['http_req_failed{scenario:measure}'], ['rate<0.01']);
  assert.deepEqual(t['checks{scenario:measure}'], ['rate>0.99']);
  assert.deepEqual(t.dropped_iterations, ['count<=30']); // 30600 planned × 0.001
  assert.deepEqual(t['checks{scenario:warm-up}'], [{ threshold: 'rate>0.99', abortOnFail: true }]);
  assert.deepEqual(t['events_sent{scenario:measure}'], ['count>=0']);
  assert.deepEqual(t['events_accepted{scenario:measure}'], ['count>=0']);
});

test('MAX_DROPPED_RATE is configurable', () => {
  const t = thresholdsFor('load', 'http', { changes: { MAX_DROPPED_RATE: 0.01 } });
  assert.deepEqual(t.dropped_iterations, ['count<=306']);
});

test('no warm-up phase → no warm-up abort rule', () => {
  const t = thresholdsFor('load', 'http', { changes: { WARM_UP_DURATION: 0 } });
  assert.equal(t['checks{scenario:warm-up}'], undefined);
  assert.deepEqual(t.dropped_iterations, ['count<=30']);
});

test('http smoke: smoke scenario rules, checks abort at once', () => {
  const t = thresholdsFor('smoke', 'http');
  assert.deepEqual(t['http_req_duration{scenario:smoke}'], ['p(95)<500']);
  assert.deepEqual(t['checks{scenario:smoke}'], [{ threshold: 'rate>0.99', abortOnFail: true }]);
  assert.deepEqual(t.dropped_iterations, ['count<=0']);
  assert.equal(t['checks{scenario:warm-up}'], undefined);
  assert.deepEqual(t['events_sent{scenario:smoke}'], ['count>=0']);
});

test('http stress adds the 10% safety stop', () => {
  const t = thresholdsFor('stress', 'http');
  assert.deepEqual(t['http_req_failed{scenario:measure}'], [
    'rate<0.01',
    { threshold: 'rate<0.1', abortOnFail: true, delayAbortEval: '10s' },
  ]);
  assert.deepEqual(t.dropped_iterations, ['count<=120']);
});

test('http breakpoint: per-level abort rules and the dropped abort', () => {
  const t = thresholdsFor('breakpoint', 'http');
  const abort = (threshold) => ({ threshold, abortOnFail: true, delayAbortEval: '10s' });
  for (const rate of [200, 400, 800, 1600, 3200, 6400]) {
    assert.deepEqual(t[`http_req_duration{level:${rate}}`], [abort('p(95)<500')]);
    assert.deepEqual(t[`http_req_failed{level:${rate}}`], [abort('rate<0.01')]);
    assert.deepEqual(t[`checks{level:${rate}}`], [abort('rate>0.99')]);
    assert.deepEqual(t[`iterations{level:${rate}}`], ['count>=0']);
  }
  assert.deepEqual(t.dropped_iterations, [{ threshold: 'count<1000', abortOnFail: true }]);
  assert.equal(t['http_req_duration{scenario:measure}'], undefined);
});

test('kafka flood and load: write errors, checks, dropped allowance, no HTTP rules', () => {
  const flood = thresholdsFor('breakpoint', 'kafka', { breakpointKind: 'flood' });
  assert.deepEqual(flood.kafka_writer_error_count, ['count<=0']);
  assert.deepEqual(flood['checks{scenario:measure}'], ['rate>0.99']);
  assert.deepEqual(flood.dropped_iterations, ['count<=120']); // (600 + 120000) × 0.001
  assert.equal(
    Object.keys(flood).some((key) => key.startsWith('http_')),
    false,
  );
  const load = thresholdsFor('load', 'kafka', {
    breakpointKind: 'flood',
    changes: { MATCHER_MAX_KAFKA_WRITE_ERRORS: 3 },
  });
  assert.deepEqual(load.kafka_writer_error_count, ['count<=3']);
});

test('per-window dummy rules for every window', () => {
  const http = thresholdsFor('load', 'http');
  for (let i = 0; i < 60; i += 1) {
    assert.deepEqual(http[`iterations{window:${i}}`], ['count>=0']);
    assert.deepEqual(http[`checks{window:${i}}`], ['rate>=0']);
    assert.deepEqual(http[`http_req_duration{window:${i}}`], ['p(95)>=0']);
    assert.deepEqual(http[`http_req_failed{window:${i}}`], ['rate>=0']);
  }
  assert.equal(http['iterations{window:60}'], undefined);
  const kafka = thresholdsFor('breakpoint', 'kafka', { breakpointKind: 'flood' });
  assert.deepEqual(kafka['iterations{window:5}'], ['count>=0']);
  assert.equal(kafka['http_req_duration{window:0}'], undefined);
});

test('Step SLA plans have no k6 thresholds', () => {
  assert.throws(
    () => thresholdsFor('load', 'http', { breakpointKind: 'none' }),
    /no k6 thresholds/,
  );
});

test('describeThreshold uses plain words', () => {
  assert.deepEqual(describeThreshold('http_req_duration{scenario:measure}', 'p(95)<500'), {
    metric: 'http_req_duration{scenario:measure}',
    rule: 'p(95)<500',
    description: '95% of requests answered within 500 ms (measured phase)',
    unit: 'ms',
  });
  assert.equal(
    describeThreshold('http_req_failed{level:400}', { threshold: 'rate<0.01', abortOnFail: true })
      .description,
    'under 1% of requests failed (HTTP error or no answer) at level 400/s — stops the test when broken',
  );
  assert.equal(
    describeThreshold('dropped_iterations', 'count<=30').description,
    'at most 30 events k6 could not send on time (dropped iterations)',
  );
  assert.equal(
    describeThreshold('checks{scenario:warm-up}', 'rate>0.99').description,
    "over 99% of the test's checks passed (warm-up phase)",
  );
  assert.equal(
    describeThreshold('kafka_writer_error_count', 'count<=0').description,
    'at most 0 Kafka write errors',
  );
  assert.match(
    describeThreshold('iterations{window:3}', 'count>=0').description,
    /not a pass\/fail rule/,
  );
});
