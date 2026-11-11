/**
 * summary.spec.mjs — unit tests of lib/summary.js and checks of the k6 summary fixtures (plan §5.3)
 *
 * What:    Checks that writeSummary writes the raw k6 data plus the context block to the right path and
 *          prints a short text without the dummy rules; and that the fixtures A2 builds on have the
 *          promised shape: the captured k6 2.3.0 sample (setup_data.k6StartedAtMs, state.testRunDurationMs,
 *          thresholds as {rule: {ok}}) and the synthetic breakpoint/Kafka ones (level/window keys).
 * How:     node --test lib/unit-tests/
 * Needs:   Node.js 22; lib/unit-tests/fixtures/k6-summary-{sample,breakpoint,kafka}.json.
 * Outputs: Test results on stdout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { markK6Start, writeSummary, summaryText } from '../summary.js';
import { buildThresholds, isDummyRule } from '../thresholds.js';
import { settingsWith } from './settings-fixture.mjs';

/** Reads one fixture file. */
function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

const CONTEXT = {
  runId: '20261105-142233',
  subject: 'collector',
  testType: 'load',
  phasePlan: { measuredPhase: 'measure' },
  resultsDirInContainer: '/tests/results/collector-load-20261105-142233',
};

test('markK6Start returns the current time in ms', () => {
  const before = Date.now();
  const { k6StartedAtMs } = markK6Start();
  assert.ok(k6StartedAtMs >= before && k6StartedAtMs <= Date.now());
});

test('writeSummary: raw data + context block at <resultsDirInContainer>/k6-summary.json', () => {
  const data = {
    metrics: {
      events_sent: { type: 'counter', values: { count: 10 } },
      dropped_iterations: {
        type: 'counter',
        values: { count: 1 },
        thresholds: { 'count<=0': { ok: false } },
      },
      'iterations{window:0}': {
        type: 'counter',
        values: { count: 10 },
        thresholds: { 'count>=0': { ok: true } },
      },
    },
    setup_data: { k6StartedAtMs: Date.parse('2026-11-05T08:52:33.000Z') },
    state: { testRunDurationMs: 12345.6 },
  };
  const out = writeSummary(data, CONTEXT);
  const file = '/tests/results/collector-load-20261105-142233/k6-summary.json';
  assert.deepEqual(Object.keys(out).sort(), [file, 'stdout'].sort());
  const written = JSON.parse(out[file]);
  assert.deepEqual(written.metrics, data.metrics);
  assert.deepEqual(written.context, {
    runId: '20261105-142233',
    subject: 'collector',
    testType: 'load',
    phasePlan: { measuredPhase: 'measure' },
    k6StartedAt: '2026-11-05T08:52:33.000Z',
    testRunDurationMs: 12345.6,
  });
  assert.match(out.stdout, /events sent 10, accepted 0/);
  assert.match(out.stdout, /thresholds: 0 passed, 1 failed/);
  assert.match(out.stdout, /FAILED dropped_iterations count<=0/);
  assert.doesNotMatch(out.stdout, /window/);
});

test('writeSummary without markK6Start gives k6StartedAt null', () => {
  const out = writeSummary({ metrics: {}, state: {} }, CONTEXT);
  const written = JSON.parse(Object.values(out)[0]);
  assert.equal(written.context.k6StartedAt, null);
  assert.equal(written.context.testRunDurationMs, null);
});

test('summaryText accepts plain-boolean thresholds too', () => {
  const text = summaryText(
    { metrics: { checks: { values: { rate: 1 }, thresholds: { 'rate>0.99': true } } } },
    CONTEXT,
  );
  assert.match(text, /1 passed, 0 failed/);
});

test('captured sample (k6 2.3.0, network none) has the shape A2 relies on', () => {
  const sample = fixture('k6-summary-sample.json');
  assert.equal(typeof sample.setup_data.k6StartedAtMs, 'number');
  assert.equal(typeof sample.state.testRunDurationMs, 'number');
  assert.equal(sample.context.k6StartedAt, new Date(sample.setup_data.k6StartedAtMs).toISOString());
  assert.equal(sample.context.testRunDurationMs, sample.state.testRunDurationMs);
  for (const key of ['runId', 'subject', 'testType', 'phasePlan'])
    assert.ok(key in sample.context, key);
  // Threshold outcomes are { "<rule>": { ok: boolean } }.
  const outcomes = Object.values(sample.metrics).flatMap((m) => Object.values(m.thresholds || {}));
  assert.ok(outcomes.length > 0);
  for (const outcome of outcomes) assert.equal(typeof outcome.ok, 'boolean');
  for (const key of [
    'http_req_duration{level:2}',
    'iterations{window:0}',
    'events_sent{scenario:measure}',
    'checks{scenario:warm-up}',
  ]) {
    assert.ok(sample.metrics[key], key);
  }
  assert.equal(sample.metrics['http_req_failed{level:2}'].thresholds['rate<0.01'].ok, false);
  assert.deepEqual(sample.options.summaryTrendStats, [
    'avg',
    'min',
    'med',
    'max',
    'p(90)',
    'p(95)',
    'p(99)',
  ]);
});

for (const [name, kind] of [
  ['k6-summary-breakpoint.json', 'http'],
  ['k6-summary-kafka.json', 'kafka'],
]) {
  test(`${name}: every threshold of its phase plan is present with {ok}, plus the context block`, () => {
    const summary = fixture(name);
    const expected = buildThresholds({
      phasePlan: summary.context.phasePlan,
      settings: settingsWith(),
      kind,
    });
    for (const [key, rules] of Object.entries(expected)) {
      assert.ok(summary.metrics[key], `${name} has ${key}`);
      for (const rule of rules) {
        const text = typeof rule === 'string' ? rule : rule.threshold;
        assert.equal(typeof summary.metrics[key].thresholds[text].ok, 'boolean', `${key} ${text}`);
      }
    }
    assert.equal(typeof summary.setup_data.k6StartedAtMs, 'number');
    assert.equal(
      summary.context.k6StartedAt,
      new Date(summary.setup_data.k6StartedAtMs).toISOString(),
    );
    assert.equal(summary.context.testRunDurationMs, summary.state.testRunDurationMs);
    assert.ok(Object.keys(summary.metrics).some((key) => key.includes('{window:')));
  });
}

test('synthetic breakpoint: level keys; only the 3200/s latency rule failed; 6400/s not reached', () => {
  const summary = fixture('k6-summary-breakpoint.json');
  const failed = Object.entries(summary.metrics).flatMap(([key, m]) =>
    Object.entries(m.thresholds || {})
      .filter(([rule, o]) => !o.ok && !isDummyRule(rule))
      .map(([rule]) => `${key} ${rule}`),
  );
  assert.deepEqual(failed, ['http_req_duration{level:3200} p(95)<500']);
  assert.equal(summary.metrics['iterations{level:6400}'].values.count, 0);
  assert.equal(summary.context.testType, 'breakpoint');
});

test('synthetic Kafka: xk6-kafka metric names and no failed rule', () => {
  const summary = fixture('k6-summary-kafka.json');
  for (const key of [
    'kafka_writer_message_count',
    'kafka_writer_error_count',
    'dropped_iterations',
    'events_accepted{scenario:measure}',
  ]) {
    assert.ok(summary.metrics[key], key);
  }
  assert.equal(summary.metrics.dropped_iterations.thresholds['count<=120'].ok, true);
  assert.equal(summary.context.subject, 'matcher');
});
