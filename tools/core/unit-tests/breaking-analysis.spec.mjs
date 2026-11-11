/**
 * breaking-analysis.spec.mjs — unit tests of tools/core/breaking-analysis.mjs (plan §6.9).
 *
 * What:    Windows (two broken windows in a row → started breaking, clock = measureStart + offset), the k6
 *          limit for a load run (v1's case: 11 dropped of 30,020 at p95 20 ms), staircase levels from A1's
 *          synthetic breakpoint summary (held 1,600/s, broke at 3,200/s, 6,400/s not reached), a staircase
 *          broken only by k6 sending (→ "at least X/s (k6 limit)"), the matcher backlog series and the
 *          diagnostics within ±1 window of the break.
 * How:     node --test tools/core/unit-tests/breaking-analysis.spec.mjs
 * Needs:   lib/phase-plan.js; lib/unit-tests/fixtures/k6-summary-breakpoint.json (A1; skipped if absent).
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  analyseBacklogSeries,
  analyseLevels,
  analyseWindows,
  diagnosticsNear,
  firstBreak,
} from '../breaking-analysis.mjs';
import { readJsonFile } from '../json-file.mjs';
import { normaliseK6Summary } from '../k6-summary.mjs';
import { buildPhasePlan } from '../lib-bridge.mjs';
import { repoPath } from '../paths.mjs';
import { defaultValues } from './helpers.mjs';

const MEASURE_START = '2026-11-05T14:23:40.000+05:30';

/** Load plan of v1's case: warm-up 2 s at 10/s (20 events) + 600 s at 50/s (30,000) = 30,020 planned. */
function loadPlan(extra = {}) {
  const settings = defaultValues({ WARM_UP_DURATION: '2s', ...extra });
  return {
    settings,
    phasePlan: buildPhasePlan({ testType: 'load', settings, breakpointKind: 'staircase' }),
  };
}

/** A summary with 60 full windows (500 sent each) and the given extra metrics. */
function windowSummary({
  p95 = 20,
  windowP95 = () => 20,
  windowSent = () => 500,
  extra = {},
  durationMs = 602000,
} = {}) {
  const metrics = {
    'http_req_duration{scenario:measure}': {
      type: 'trend',
      values: { 'p(95)': p95 },
      thresholds: { 'p(95)<500': { ok: p95 < 500 } },
    },
    ...extra,
  };
  for (let i = 0; i < 60; i += 1) {
    metrics[`iterations{window:${i}}`] = {
      values: { count: windowSent(i) },
      thresholds: { 'count>=0': { ok: true } },
    };
    metrics[`http_req_duration{window:${i}}`] = {
      values: { 'p(95)': windowP95(i) },
      thresholds: { 'p(95)>=0': { ok: true } },
    };
    metrics[`http_req_failed{window:${i}}`] = {
      values: { rate: 0 },
      thresholds: { 'rate>=0': { ok: true } },
    };
  }
  return normaliseK6Summary({ metrics, state: { testRunDurationMs: durationMs } });
}

test('firstBreak needs N broken in a row', () => {
  assert.equal(firstBreak([false, true, false, true, true], 2), 3);
  assert.equal(firstBreak([true, false], 2), -1);
  assert.equal(firstBreak([false, true], 1), 1);
});

test('windows: latency over the limit in two windows in a row → started breaking at the first of them', () => {
  const { settings, phasePlan } = loadPlan();
  assert.equal(phasePlan.plannedEvents, 30020);
  const normalised = windowSummary({ p95: 640, windowP95: (i) => (i === 5 || i >= 31 ? 900 : 30) });
  const analysis = analyseWindows({ normalised, phasePlan, settings, measureStart: MEASURE_START });
  assert.equal(analysis.secondsIntoMeasure, 310);
  assert.equal(
    new Date(analysis.startedBreakingAt).getTime(),
    new Date(MEASURE_START).getTime() + 310_000,
  );
  assert.equal(analysis.rateAtBreak, 50);
  assert.match(analysis.whatBroke[0].description, /p95 up to 900 ms \(rule < 500 ms\)/);
  assert.equal(analysis.k6Limited, false);
  assert.equal(analysis.points.length, 60);
});

test('k6 limit, load window case: 11 dropped of 30,020 at p95 20 ms', () => {
  // With the default rule (<= 30 dropped = 0.1 %), 11 dropped is within the rule: nothing broke.
  const { settings, phasePlan } = loadPlan();
  const within = analyseWindows({
    normalised: windowSummary({
      extra: {
        dropped_iterations: { values: { count: 11 }, thresholds: { 'count<=30': { ok: true } } },
      },
    }),
    phasePlan,
    settings,
    measureStart: MEASURE_START,
  });
  assert.equal(within.k6Limited, false);
  assert.deepEqual(within.whatBroke, []);
  // With v1's "0 dropped" rule the run fails, but only on sending while the service answered in 20 ms.
  const strict = loadPlan({ MAX_DROPPED_RATE: '0' });
  const limited = analyseWindows({
    normalised: windowSummary({
      extra: {
        dropped_iterations: { values: { count: 11 }, thresholds: { 'count<=0': { ok: false } } },
      },
    }),
    phasePlan: strict.phasePlan,
    settings: strict.settings,
    measureStart: MEASURE_START,
  });
  assert.equal(limited.k6Limited, true);
  assert.equal(limited.whatBroke.length, 1);
  assert.equal(limited.whatBroke[0].metric, 'k6-limit');
  assert.match(
    limited.whatBroke[0].description,
    /k6 could not send 11 on time \(k6 limit, service p95 20 ms\)/,
  );
});

test('a short window (k6 could not send on time) with a slow service is NOT a k6 limit', () => {
  const { settings, phasePlan } = loadPlan();
  const normalised = windowSummary({ p95: 300, windowSent: (i) => (i >= 10 ? 400 : 500) });
  const analysis = analyseWindows({ normalised, phasePlan, settings, measureStart: MEASURE_START });
  assert.equal(analysis.secondsIntoMeasure, 100);
  assert.equal(analysis.k6Limited, false, 'p95 300 ms is not below K6_LIMIT_P95_MS 100');
  assert.match(analysis.whatBroke.at(-1).description, /events k6 could not send on time/);
});

test('windows after k6 stopped are not judged as short', () => {
  const { settings, phasePlan } = loadPlan();
  // k6 stopped 100 s into the measured phase; later windows have no data.
  const normalised = windowSummary({ windowSent: (i) => (i < 10 ? 500 : 0), durationMs: 102000 });
  const analysis = analyseWindows({ normalised, phasePlan, settings, measureStart: MEASURE_START });
  assert.equal(analysis.points.length, 10);
  assert.equal(analysis.startedBreakingAt, null);
});

const BREAKPOINT = repoPath('lib/unit-tests/fixtures/k6-summary-breakpoint.json');

test(
  'staircase from A1 synthetic summary: held 1,600/s, broke at 3,200/s on p95, 6,400/s not reached',
  { skip: !fs.existsSync(BREAKPOINT) && 'A1 fixture missing' },
  () => {
    const raw = readJsonFile(BREAKPOINT);
    const settings = defaultValues();
    const analysis = analyseLevels({
      normalised: normaliseK6Summary(raw),
      phasePlan: raw.context.phasePlan,
      settings,
      measureStart: MEASURE_START,
    });
    assert.equal(analysis.heldUpTo, 1600);
    assert.equal(analysis.brokeAtRate, 3200);
    assert.equal(analysis.k6Limited, false);
    assert.deepEqual(
      analysis.levels.map((l) => l.result),
      ['held', 'held', 'held', 'held', 'broke', 'not-reached'],
    );
    assert.equal(analysis.levels.at(-1).p95Ms, null, 'a level never reached has no latency');
    assert.equal(analysis.secondsIntoMeasure, 240);
    assert.match(analysis.whatBroke[0].description, /at 3,200\/s: p95 812\.5 ms \(rule < 500 ms\)/);
  },
);

test('staircase broken only by dropped iterations at low latency → top level broke, "at least X/s (k6 limit)"', () => {
  const settings = defaultValues({
    LEVELS: '200,400',
    LEVEL_DURATION: '10s',
    WARM_UP_DURATION: '0s',
  });
  const phasePlan = buildPhasePlan({
    testType: 'breakpoint',
    settings,
    breakpointKind: 'staircase',
  });
  const metrics = {
    dropped_iterations: { values: { count: 1500 }, thresholds: { 'count<1000': { ok: false } } },
  };
  for (const rate of [200, 400]) {
    metrics[`iterations{level:${rate}}`] = {
      values: { count: rate * 10 },
      thresholds: { 'count>=0': { ok: true } },
    };
    metrics[`http_req_duration{level:${rate}}`] = {
      values: { 'p(95)': 15 },
      thresholds: { 'p(95)<500': { ok: true } },
    };
    metrics[`http_req_failed{level:${rate}}`] = {
      values: { rate: 0 },
      thresholds: { 'rate<0.01': { ok: true } },
    };
  }
  const analysis = analyseLevels({
    normalised: normaliseK6Summary({ metrics, state: { testRunDurationMs: 20000 } }),
    phasePlan,
    settings,
    measureStart: MEASURE_START,
  });
  assert.deepEqual(
    analysis.levels.map((l) => l.result),
    ['held', 'broke'],
  );
  assert.match(analysis.levels[1].reasons.join(), /k6 dropped 1,500/);
  assert.equal(analysis.k6Limited, true);
  assert.equal(analysis.heldUpTo, 200);
  assert.match(analysis.whatBroke[0].description, /at least 200\/s \(k6 limit\)/);
});

test('backlog series: first of N samples in a row above the limit, within the measured phase', () => {
  const at = (s) => new Date(new Date(MEASURE_START).getTime() + s * 1000).toISOString();
  const samples = [
    { at: at(-5), backlog: 5000 }, // before measuring: ignored
    { at: at(0), backlog: 10 },
    { at: at(5), backlog: 1500 },
    { at: at(10), backlog: 900 },
    { at: at(15), backlog: 1200 },
    { at: at(20), backlog: 28811 },
  ];
  const analysis = analyseBacklogSeries({
    samples,
    limit: 1000,
    consecutive: 2,
    measureStart: MEASURE_START,
  });
  assert.equal(analysis.secondsIntoMeasure, 15);
  assert.equal(analysis.maxBacklog, 28811);
});

test('diagnosticsNear: service signals that first went bad within ±1 window of the break', () => {
  const breakAt = '2026-11-05T14:24:11.000+05:30';
  const peaks = {
    matcher: {
      hikariPendingMax: { value: 7, firstAt: '2026-11-05T14:24:02.000+05:30' }, // 9 s before: inside
      gcPauseMaxMs: { value: 900, firstAt: '2026-11-05T14:30:00.000+05:30' }, // far away: outside
      processCpuMax: { value: 0.7, firstAt: null },
    },
  };
  const entries = diagnosticsNear({ peaks, startedBreakingAt: breakAt, windowSeconds: 10 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, 'service-metrics');
  assert.match(
    entries[0].description,
    /matcher DB pool: requests waiting for a connection from \d\d:\d\d:\d\d \(diagnostic\)/,
  );
  assert.deepEqual(diagnosticsNear({ peaks, startedBreakingAt: null, windowSeconds: 10 }), []);
});
