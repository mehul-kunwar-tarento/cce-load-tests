/**
 * k6-summary.spec.mjs — unit tests of tools/core/k6-summary.mjs (plan §5.3).
 *
 * What:    Both threshold shapes (handleSummary {ok} and --summary-export true = crossed), sub-metric lookup,
 *          failed rules without the dummy summary-forcing rules, thresholdsFromK6 (dummy rules dropped, ids,
 *          limits, TBC flags), k6Timing — on synthetic data AND on A1's captured real summary
 *          (lib/unit-tests/fixtures/k6-summary-sample.json; skipped with a note while it does not exist).
 * How:     node --test tools/core/unit-tests/k6-summary.spec.mjs
 * Needs:   lib/thresholds.js (A1) through lib-bridge; A1's fixture for the last test.
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { readJsonFile } from '../json-file.mjs';
import {
  failedThresholds,
  k6Timing,
  normaliseK6Summary,
  parseRule,
  subMetric,
  thresholdsFromK6,
} from '../k6-summary.mjs';
import { repoPath } from '../paths.mjs';
import { defaultValues } from './helpers.mjs';

const settings = defaultValues();

/** A small handleSummary-shaped summary. */
const handleSummary = {
  metrics: {
    'http_req_duration{scenario:measure}': {
      type: 'trend',
      values: { 'p(95)': 666, avg: 120 },
      thresholds: { 'p(95)<500': { ok: false } },
    },
    'http_req_failed{scenario:measure}': {
      type: 'rate',
      values: { rate: 0.001, passes: 1, fails: 999 },
      thresholds: { 'rate<0.01': { ok: true } },
    },
    'iterations{window:3}': {
      type: 'counter',
      values: { count: 500 },
      thresholds: { 'count>=0': { ok: true } },
    },
    'http_req_duration{level:400}': {
      type: 'trend',
      values: { 'p(95)': 12 },
      thresholds: { 'p(95)<500': { ok: true } },
    },
    dropped_iterations: {
      type: 'counter',
      values: { count: 11 },
      thresholds: { 'count<=30': { ok: true } },
    },
  },
  state: { testRunDurationMs: 660000 },
  context: { k6StartedAt: '2026-11-05T08:52:40.000Z', testRunDurationMs: 660000 },
};

test('normalises handleSummary: values, thresholds {ok}, context and duration', () => {
  const n = normaliseK6Summary(handleSummary);
  assert.equal(n.metrics['http_req_duration{scenario:measure}'].values['p(95)'], 666);
  assert.deepEqual(n.metrics['http_req_duration{scenario:measure}'].thresholds, {
    'p(95)<500': { ok: false },
  });
  assert.equal(n.durationMs, 660000);
  assert.deepEqual(k6Timing(n), {
    k6StartedAt: '2026-11-05T08:52:40.000Z',
    testRunDurationMs: 660000,
  });
});

test('normalises --summary-export: flat values, rate from "value", true means the threshold was crossed', () => {
  const n = normaliseK6Summary({
    metrics: {
      http_req_failed: { value: 0.2, passes: 2, fails: 8, thresholds: { 'rate<0.01': true } },
      http_req_duration: { 'p(95)': 50, thresholds: { 'p(95)<500': false } },
    },
  });
  assert.equal(n.metrics.http_req_failed.values.rate, 0.2);
  assert.equal(n.metrics.http_req_failed.thresholds['rate<0.01'].ok, false);
  assert.equal(n.metrics.http_req_duration.thresholds['p(95)<500'].ok, true);
  assert.deepEqual(k6Timing(n), { k6StartedAt: null, testRunDurationMs: null });
});

test('subMetric finds single-tag sub-metrics and the whole metric', () => {
  const n = normaliseK6Summary(handleSummary);
  assert.equal(subMetric(n, 'http_req_duration', 'level', 400).values['p(95)'], 12);
  assert.equal(subMetric(n, 'iterations', 'window', '3').values.count, 500);
  assert.equal(subMetric(n, 'dropped_iterations').values.count, 11);
  assert.equal(subMetric(n, 'iterations', 'window', 9), null);
});

test('parseRule splits stat, operator and limit', () => {
  assert.deepEqual(parseRule('p(95)<500'), { stat: 'p(95)', op: '<', limit: 500 });
  assert.deepEqual(parseRule('count<=30'), { stat: 'count', op: '<=', limit: 30 });
  assert.equal(parseRule('nonsense'), null);
});

test('failedThresholds lists real failed rules only (dummy rules never count)', () => {
  const n = normaliseK6Summary({
    metrics: {
      ...handleSummary.metrics,
      'iterations{window:4}': { values: { count: 0 }, thresholds: { 'count>=0': { ok: false } } },
    },
  });
  assert.deepEqual(failedThresholds(n), [
    { key: 'http_req_duration{scenario:measure}', rule: 'p(95)<500' },
  ]);
});

test('thresholdsFromK6: one Threshold per non-dummy rule, with id, limit, actual, unit and TBC flag', () => {
  const thresholds = thresholdsFromK6(normaliseK6Summary(handleSummary), settings, 'http');
  assert.ok(
    !thresholds.some((t) => t.metric.startsWith('iterations{window')),
    'dummy rules dropped',
  );
  const p95 = thresholds.find((t) => t.id === 'k6.http_req_duration.scenario:measure');
  assert.deepEqual(
    {
      limit: p95.limit,
      actual: p95.actual,
      unit: p95.unit,
      passed: p95.passed,
      toBeConfirmed: p95.toBeConfirmed,
      source: p95.source,
    },
    { limit: 500, actual: 666, unit: 'ms', passed: false, toBeConfirmed: true, source: 'k6' },
  );
  const dropped = thresholds.find((t) => t.id === 'k6.dropped_iterations');
  assert.equal(dropped.actual, 11);
  assert.equal(dropped.toBeConfirmed, true, 'MAX_DROPPED_RATE is to be confirmed');
  assert.equal(new Set(thresholds.map((t) => t.id)).size, thresholds.length, 'ids are unique');
});

const SAMPLE = repoPath('lib/unit-tests/fixtures/k6-summary-sample.json');

test(
  'A1 captured k6 2.3.0 summary normalises (real shape: level/window/scenario sub-metrics)',
  { skip: !fs.existsSync(SAMPLE) && 'A1 fixture not present yet' },
  () => {
    const n = normaliseK6Summary(readJsonFile(SAMPLE));
    // The captured probe sent to a dead address: both levels' failed-request rules broke.
    const failed = failedThresholds(n)
      .map((f) => f.key)
      .sort();
    assert.deepEqual(failed, ['http_req_failed{level:2}', 'http_req_failed{level:4}']);
    assert.ok(subMetric(n, 'iterations', 'level', 2).values.count > 0);
    assert.match(k6Timing(n).k6StartedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof k6Timing(n).testRunDurationMs, 'number');
    const thresholds = thresholdsFromK6(n, settings, 'http');
    assert.ok(thresholds.length > 0);
    assert.ok(
      thresholds.every((t) => !/>=0$/.test(t.rule.replace(/\s/g, ''))),
      'no dummy rule reported',
    );
  },
);
