/**
 * baseline.spec.mjs — unit tests of tools/baseline/baseline-store.mjs and baseline-compare.mjs (plan §8.3).
 *
 * What:    judge(): "same" within the tolerance OR below the unit floor, else better/worse by direction;
 *          compare: mean of the given runs, "not caught up" never a number, metrics on one side only
 *          "not-compared", condition warnings (host, set, data volume > 50 %), provisional flag; store:
 *          statistics, the loader drops $comment, names that could escape the folder are refused.
 * How:     node --test tools/baseline/unit-tests/baseline.spec.mjs
 * Needs:   fixtures/local-sample.json; tools/report/unit-tests/fixtures/results/ (run results).
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../core/unit-tests/helpers.mjs';
import {
  UNIT_FLOORS,
  compareWithBaseline,
  conditionWarnings,
  judge,
} from '../baseline-compare.mjs';
import {
  conditionsOf,
  defaultBaselineMetrics,
  listBaselines,
  loadBaseline,
  statistics,
  validateBaselineName,
} from '../baseline-store.mjs';

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;
const RESULTS = new URL('../../report/unit-tests/fixtures/results/', import.meta.url).pathname;
const result = (name) =>
  JSON.parse(fs.readFileSync(path.join(RESULTS, name, 'result.json'), 'utf8'));
const baseline = () => loadBaseline('local-sample', { baselinesDir: FIXTURES });

/** Metrics as a module would declare them, for the two subjects used here. */
const metricsFor = (r) => [
  ...defaultBaselineMetrics(r).map((m) =>
    m.key === `${r.subject}.${r.testType}.p95Ms` ? { ...m, label: 'Collector load p95' } : m,
  ),
];

test('unit floors of plan §8.3', () => {
  assert.deepEqual(UNIT_FLOORS, { ms: 5, s: 2, events: 100, 'events/s': 5, 'alarms/s': 20 });
});

test('judge: same within tolerance or below the floor; else better/worse by direction', () => {
  assert.equal(
    judge({ baseline: 15.4, current: 18, unit: 'ms', better: 'lower', tolerance: 5 }).verdict,
    'same',
    '2.6 ms < 5 ms floor',
  );
  assert.equal(
    judge({ baseline: 100, current: 115, unit: 'ms', better: 'lower', tolerance: 20 }).verdict,
    'same',
    '15 % ≤ 20 %',
  );
  assert.equal(
    judge({ baseline: 100, current: 130, unit: 'ms', better: 'lower', tolerance: 20 }).verdict,
    'worse',
  );
  assert.equal(
    judge({ baseline: 100, current: 70, unit: 'ms', better: 'lower', tolerance: 20 }).verdict,
    'better',
  );
  assert.equal(
    judge({ baseline: 300, current: 200, unit: 'events/s', better: 'higher', tolerance: 20 })
      .verdict,
    'worse',
  );
  const r = judge({
    baseline: 200,
    current: 250,
    unit: 'events/s',
    better: 'higher',
    tolerance: 20,
  });
  assert.deepEqual([r.verdict, r.delta, r.deltaPercent], ['better', 50, 25]);
});

test('loadBaseline drops the $comment; listBaselines; names cannot escape the folder', () => {
  const b = baseline();
  assert.ok(!('$comment' in b));
  assert.equal(b.metrics['collector.load.p95Ms'].mean, 15.433);
  assert.deepEqual(
    listBaselines({ baselinesDir: FIXTURES }).map((x) => x.name),
    ['local-sample'],
  );
  assert.throws(() => validateBaselineName('../x'));
  assert.throws(() => loadBaseline('missing', { baselinesDir: FIXTURES }), /Known: local-sample/);
});

test('statistics: mean, min, max and population standard deviation', () => {
  assert.deepEqual(statistics([15.4, 16.0, 14.9]), {
    mean: 15.433,
    min: 14.9,
    max: 16,
    stddev: 0.45,
  });
  assert.deepEqual(statistics([]), { mean: null, min: null, max: null, stddev: null });
});

test('compare a collector load run: verdicts, metrics on one side only, condition warnings', () => {
  const run = result('collector-load-20261105-120000');
  run.latency.p95 = 31.2;
  const comparison = compareWithBaseline({
    baseline: baseline(),
    results: [run],
    metricsFor,
    tolerance: 20,
  });
  const byKey = Object.fromEntries(comparison.rows.map((row) => [row.key, row]));
  assert.equal(byKey['collector.load.p95Ms'].verdict, 'worse');
  assert.equal(byKey['collector.load.p95Ms'].current, 31.2);
  assert.equal(byKey['collector.load.averageRate'].verdict, 'same');
  assert.equal(byKey['matcher.stress.catchUpSeconds'].verdict, 'not-compared');
  assert.equal(byKey['matcher.stress.catchUpSeconds'].note, 'not measured in these runs');
  assert.equal(comparison.kind, 'cce-baseline-comparison');
  assert.equal(comparison.provisional, false);
  // The fixture run differs from the baseline in data volume (1.5 GB vs 0.5 GB) — flagged.
  assert.ok(comparison.warnings.some((w) => /database size/.test(w)));
});

test('"not caught up" is never compared as a number (v1 give-up bug)', () => {
  const run = result('matcher-stress-20261105-142233');
  const metrics = () => [
    {
      key: 'matcher.stress.catchUpSeconds',
      label: 'Matcher stress catch-up',
      unit: 's',
      better: 'lower',
      value: 121.4,
    },
  ];
  const row = compareWithBaseline({
    baseline: baseline(),
    results: [run],
    metricsFor: metrics,
  }).rows.find((r) => r.key === 'matcher.stress.catchUpSeconds');
  assert.equal(row.verdict, 'not-compared');
  assert.equal(row.note, 'not caught up');
  assert.equal(row.current, null);
});

test('condition warnings: host, cpus, plan-definition set, settings, suite commit', () => {
  const current = conditionsOf(result('collector-load-20261105-120000'));
  const differing = {
    ...baseline().conditions,
    host: { hostname: 'other', cpus: 4 },
    planDefinitionSet: { name: 'emr-service', fanOut: 1, canonicals: [] },
    suiteCommit: 'zzz9999',
  };
  const warnings = conditionWarnings(differing, current).join('\n');
  assert.match(warnings, /host perf-laptop 16 CPUs \(baseline other 4 CPUs\)/);
  assert.match(
    warnings,
    /plan-definition set overlapping-4 fan-out 4 \(baseline emr-service fan-out 1\)/,
  );
  assert.match(warnings, /suite commit abc1234 \(baseline zzz9999\)/);
});

test('a provisional baseline is announced in every comparison', () => {
  const b = { ...baseline(), provisional: true };
  const comparison = compareWithBaseline({
    baseline: b,
    results: [result('collector-load-20261105-120000')],
    metricsFor,
  });
  assert.match(comparison.warnings[0], /PROVISIONAL/);
  // Written baselines go through writeGeneratedJson; nothing is written by compare itself.
  assert.deepEqual(fs.readdirSync(tempDir()), []);
});
