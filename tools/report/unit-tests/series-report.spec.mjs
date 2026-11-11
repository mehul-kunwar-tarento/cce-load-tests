/**
 * series-report.spec.mjs — unit tests of tools/report/series-report.mjs (plan §8.2, R1.4).
 *
 * What:    From the fixture result folders: latest run per service and test type, "not run" for missing ones,
 *          v1 folders ignored, breaking points per service (matcher/Step SLA as drain rates; Step SLA × peak
 *          against STEP_SLA_PEAK_ALARM_RATE, never the events/s peak), the whole-flow weakest link (overruled
 *          by a failed stress run at or below the expected rate), data
 *          correctness, bottom line, condition differences; summary.json + summary.md written.
 * How:     node --test tools/report/unit-tests/series-report.spec.mjs
 * Needs:   fixtures/results/.
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../core/unit-tests/helpers.mjs';
import {
  buildSeriesSummary,
  readSeriesEntries,
  renderSeriesReport,
  writeSeriesReport,
} from '../series-report.mjs';

const RESULTS = new URL('./fixtures/results/', import.meta.url).pathname;
const dirs = () =>
  fs
    .readdirSync(RESULTS)
    .sort()
    .map((name) => path.join(RESULTS, name));

test('readSeriesEntries ignores folders without result.json (v1 outputs)', () => {
  const { entries, ignored } = readSeriesEntries(dirs());
  assert.equal(entries.length, 5);
  assert.deepEqual(
    ignored.map((d) => path.basename(d)),
    ['collector-load-1103003810'],
  );
});

test('summary: per service and test type, expectation, capacities, whole flow, bottom line', () => {
  const { entries, ignored } = readSeriesEntries(dirs());
  const summary = buildSeriesSummary(entries, {
    ignored,
    now: new Date('2026-11-06T10:00:00+05:30'),
  });
  assert.equal(summary.kind, 'cce-performance-summary');
  assert.deepEqual(
    summary.services.map((s) => s.subject),
    ['collector', 'matcher', 'step-sla'],
  );
  const [collector, matcher, stepSla] = summary.services;
  assert.equal(collector.load.status, 'passed');
  assert.equal(collector.load.eventsThrough, 30000);
  assert.equal(collector.load.throughBasis, 'accepted');
  assert.equal(collector.load.eventsSent, 30000);
  assert.equal(collector.stress, null, 'not run');
  assert.equal(collector.breakpoint.heldUpTo, 1600);
  assert.equal(matcher.stress.secondsIntoMeasure, 31);
  assert.deepEqual(
    matcher.stress.whatBroke,
    [
      'up to 28,811 events waiting (rule < 1,000)',
      'not caught up: 11,474 events still waiting after 120 s',
    ],
    'diagnostics are not decisions',
  );
  assert.equal(matcher.capacity.kind, 'drain-rate');
  assert.equal(stepSla.capacity.unit, 'alarms/s');
  assert.equal(summary.expectation.peakRate, 50);
  assert.equal(summary.expectation.breakpointTarget, 200);
  assert.equal(summary.wholeFlow.weakestLink.subject, 'matcher');
  assert.equal(summary.wholeFlow.weakestLink.rate, 312.5);
  assert.match(summary.wholeFlow.note, /end-to-end module is not built yet/);
  assert.match(summary.wholeFlow.note, /Step SLA \(alarms\/s\) is not part of this estimate/);
  // The matcher's 200/s stress run failed: the breakpoint drain rate alone must not say "above".
  assert.equal(summary.wholeFlow.verdict, 'below-expectation');
  assert.deepEqual(
    summary.wholeFlow.failedRuns.map((f) => [
      f.subject,
      f.testType,
      f.targetRate,
      f.belowExpectation,
    ]),
    [['matcher', 'stress', 200, true]],
  );
  assert.deepEqual(collector.failedRuns, []);
  assert.deepEqual(summary.bottomLine.load, { passed: 1, total: 1 });
  assert.deepEqual(summary.bottomLine.stress, { passed: 0, total: 1 });
  assert.equal(summary.dataCorrectness.allRequiredPassed, true);
  assert.deepEqual(summary.conditionsDiffer, []);
});

test('markdown: the eight sections, "not run", Step SLA × peak in alarms/s', () => {
  const { entries } = readSeriesEntries(dirs());
  const markdown = renderSeriesReport(buildSeriesSummary(entries));
  for (const heading of [
    '1. What we expect',
    '2. Load',
    '3. Stress',
    '4. Breaking points',
    '5. Whole flow',
    '6. Data correctness',
    '7. Bottom line',
    '8. Conditions',
  ]) {
    assert.match(markdown, new RegExp(`## ${heading.replace('.', '\\.')}`));
  }
  assert.match(markdown, /\| Matcher \| not run \| n\/a \| n\/a \| n\/a \| not run \|/);
  // Through = what the service took (R1), with what k6 sent next to it.
  assert.match(
    markdown,
    /\| Collector \| 30,000 events accepted \| 30,000 \| 10m 0s \| 50\/s \(target 50\/s\) \| PASSED \|/,
  );
  assert.match(markdown, /\| Matcher \| 108,524 events processed \| 119,998 \| /);
  assert.doesNotMatch(markdown, /\| Matcher \| 119,998 events/);
  assert.match(
    markdown,
    /\| Collector \| 1,600\/s \| 3,200\/s \| .* \| 32× peak \| above 200\/s \|/,
  );
  // 826.4 alarms/s against the Step SLA peak of 150 alarms/s (not 50 events/s) and 4 × 150 = 600 alarms/s.
  assert.match(
    markdown,
    /\| Step SLA \| drain rate 826\.4 alarms\/s \| n\/a \| n\/a \| 5\.5× peak \| above 600\/s \|/,
  );
  assert.match(
    markdown,
    /Weakest link: Matcher at 312\.5 events\/s \(6\.3 × peak\) — below expectation \(Matcher stress at 200\/s failed; the breakpoint run alone: above 200\/s\)\./,
  );
  assert.match(
    markdown,
    /- Matcher: 312\.5 events\/s \(drain-rate\) — below expectation \(stress at 200\/s failed; the breakpoint run alone: above 200\/s\)\./,
  );
  assert.match(markdown, /- Collector: 1,600 events\/s \(held-up-to\) — above 200\/s\./);
  assert.match(markdown, /Load passed 1\/1; stress passed 0\/1; breakpoint runs 3\./);
});

test('whole flow: no failed sustained run keeps the breakpoint verdict', () => {
  const { entries } = readSeriesEntries(dirs());
  const passing = entries.map((e) =>
    e.result.subject === 'matcher' && e.result.testType === 'stress'
      ? { ...e, result: { ...structuredClone(e.result), status: 'passed' } }
      : e,
  );
  const summary = buildSeriesSummary(passing);
  assert.equal(summary.wholeFlow.verdict, 'above-expectation');
  assert.deepEqual(summary.wholeFlow.failedRuns, []);
  assert.match(
    renderSeriesReport(summary),
    /Weakest link: Matcher at 312\.5 events\/s \(6\.3 × peak\) — above 200\/s\./,
  );
});

test('runs measured under different conditions are flagged; the latest run of a type wins', () => {
  const { entries } = readSeriesEntries(dirs());
  const older = structuredClone(
    entries.find((e) => e.result.subject === 'collector' && e.result.testType === 'load'),
  );
  older.result.startedAt = '2026-11-04T12:00:00.000+05:30';
  older.result.runId = '20261104-120000';
  older.result.status = 'failed';
  older.result.conditions.host.hostname = 'other-laptop';
  const summary = buildSeriesSummary([...entries, older]);
  assert.equal(summary.services[0].load.runId, '20261105-120000');
  assert.equal(summary.services[0].load.runsOfThisType, 2);
  assert.match(summary.conditionsDiffer.join(), /host differs between runs/);
});

test('writeSeriesReport writes summary.json (with $comment) and summary.md', () => {
  const out = path.join(tempDir(), 'summary');
  const { files } = writeSeriesReport({ dirs: dirs(), out });
  const json = JSON.parse(fs.readFileSync(files.json, 'utf8'));
  assert.match(json.$comment, /^What:/);
  assert.equal(json.schemaVersion, '1.0.0');
  assert.match(fs.readFileSync(files.markdown, 'utf8'), /^# CCE performance — series summary/);
});
