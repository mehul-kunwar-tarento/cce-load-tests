/**
 * sampled-metrics.spec.mjs — unit tests of tools/core/sampled-metrics.mjs (plan §6.3 peaks table).
 *
 * What:    computePeaks: max signals with firstAt (first sample over the "trouble" level), counter increases
 *          (resets do not go negative), the matcher's average processing time, signals limited to their
 *          services, and the common sampled metrics (plain names, exact labels, no wildcards).
 * How:     node --test tools/core/unit-tests/sampled-metrics.spec.mjs
 * Needs:   Nothing.
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMMON_SAMPLED_METRICS,
  PEAK_SIGNALS,
  computePeaks,
  peakLabel,
} from '../sampled-metrics.mjs';

const at = (s) => `2026-11-05T14:24:${String(s).padStart(2, '0')}.000+05:30`;

test('common sampled metrics: plain names, exact labels, no wildcards', () => {
  for (const metric of COMMON_SAMPLED_METRICS) {
    assert.match(metric.name, /^[a-z_]+$/);
    assert.ok(!JSON.stringify(metric.labels ?? {}).includes('*'));
  }
  assert.deepEqual(COMMON_SAMPLED_METRICS.map((m) => m.key).sort(), [
    'gcPauseMax',
    'heapMax',
    'heapUsed',
    'hikariActive',
    'hikariMax',
    'hikariPending',
    'hikariTimeouts',
    'processCpu',
  ]);
  assert.ok(PEAK_SIGNALS.some((s) => s.peakKey === 'processingMsAvg'));
});

test('computePeaks: max with firstAt, increase, mean-of-ratio, scaled GC pause', () => {
  const samples = [
    {
      at: at(0),
      service: 'matcher',
      metrics: {
        hikariPending: 0,
        hikariActive: 3,
        hikariMax: 10,
        hikariTimeouts: 4,
        heapUsed: 100,
        heapMax: 1000,
        gcPauseMax: 0.02,
        processCpu: 0.3,
        processingSecondsSum: 10,
        processingSecondsCount: 1000,
      },
    },
    {
      at: at(5),
      service: 'matcher',
      metrics: {
        hikariPending: 2,
        hikariActive: 10,
        hikariMax: 10,
        hikariTimeouts: 4,
        heapUsed: 950,
        heapMax: 1000,
        gcPauseMax: 0.7,
        processCpu: 0.9,
        processingSecondsSum: 27.2,
        processingSecondsCount: 2000,
      },
    },
    {
      at: at(10),
      service: 'matcher',
      metrics: {
        hikariPending: 7,
        hikariActive: 10,
        hikariMax: 10,
        hikariTimeouts: 6,
        heapUsed: 500,
        heapMax: 1000,
        gcPauseMax: 0.1,
        processCpu: 0.5,
        processingSecondsSum: 44.4,
        processingSecondsCount: 3000,
      },
    },
  ];
  const { matcher } = computePeaks({ samples });
  assert.deepEqual(matcher.hikariPendingMax, { value: 7, firstAt: at(5) });
  assert.deepEqual(matcher.hikariActiveMax, { value: 10, firstAt: at(5) });
  assert.deepEqual(matcher.hikariTimeouts, { value: 2, firstAt: at(10) });
  assert.deepEqual(matcher.heapUsedMaxBytes, { value: 950, firstAt: at(5) });
  assert.deepEqual(matcher.gcPauseMaxMs, { value: 700, firstAt: at(5) });
  assert.deepEqual(
    matcher.processCpuMax,
    { value: 0.9, firstAt: null },
    'CPU has no trouble level',
  );
  assert.equal(Math.round(matcher.processingMsAvg.value * 10) / 10, 17.2);
});

test('a counter reset (service restart) never makes a negative increase', () => {
  const samples = [5, 9, 1, 3].map((v, i) => ({
    at: at(i),
    service: 'collector',
    metrics: { kafkaPublishFailures: v },
  }));
  assert.equal(computePeaks({ samples }).collector.kafkaPublishFailures.value, 6);
});

test('signals apply only to their services; absent metrics give no peak', () => {
  const samples = [
    {
      at: at(0),
      service: 'collector',
      metrics: { processingSecondsSum: 1, processingSecondsCount: 1, hikariPending: null },
    },
  ];
  const peaks = computePeaks({ samples });
  assert.ok(!('processingMsAvg' in peaks.collector), 'matcher-only signal');
  assert.ok(!('hikariPendingMax' in peaks.collector), 'null samples produce no peak');
  assert.match(peakLabel('slaCycleCapHits'), /10,000-rows-per-cycle cap/);
});
