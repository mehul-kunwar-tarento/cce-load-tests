/**
 * evaluate.spec.mjs — unit tests of the collector's evaluation and baseline metrics on fixture k6 summaries.
 *
 * What:    Feeds synthetic k6 summaries (fixtures/, generated with the real lib/ phase-plan and threshold
 *          builders) into evaluate() and checks the answers the report depends on: a passing load
 *          (throughput rule passed, no k6 limit), a load failing only on dropped iterations while p95 stays
 *          low (k6 limit, "not a service failure"), a staircase that broke on p95 (held up to / broke at and
 *          the --refine-from hint) and a staircase k6 could not drive ("at least X/s (k6 limit)"). It also
 *          builds the whole result.json with the real result builder to prove the module's output fits the
 *          schema, and checks the baseline metric keys of plan §8.3.
 * How:     npm test   (or: node --test "cce-collector-service/unit-tests/evaluate.spec.mjs")
 * Needs:   Node 22; ./fixtures/*.json; no network.
 * Outputs: node:test results.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import collector, { evaluateCollector, serverSideTime } from '../service-module.mjs';
import { buildResult, validateResult } from '../shared.mjs';
import { fixtureSettings, readFixture } from './test-helpers.mjs';

/** Fixture name → test type it was generated for. */
const FIXTURES = {
  'k6-summary-load-passed.json': 'load',
  'k6-summary-load-k6-limited.json': 'load',
  'k6-summary-breakpoint-broke.json': 'breakpoint',
  'k6-summary-breakpoint-k6-limited.json': 'breakpoint',
};

/** ctx + partial for one fixture, as the runner would pass them (times from the k6 clock). */
function setup(fixture, { dataChecks = [], times = {} } = {}) {
  const summary = readFixture(fixture);
  const { resolved, values, phasePlan } = fixtureSettings(FIXTURES[fixture]);
  const startMs = Date.parse(summary.context.k6StartedAt);
  const measure = phasePlan.phases.find((p) => p.name === phasePlan.measuredPhase);
  const ctx = {
    settings: values,
    phasePlan,
    environment: { name: 'local' },
    context: { resultsDir: `results/collector-${phasePlan.testType}-20261105-100000` },
    resultsDir: null,
  };
  const partial = {
    k6Summary: summary,
    watcherOutcomes: [],
    dataChecks,
    times: {
      measureStart: new Date(startMs + measure.startSeconds * 1000).toISOString(),
      sendEnd: new Date(
        startMs + (measure.startSeconds + measure.durationSeconds) * 1000,
      ).toISOString(),
      sendEndedEarly: false,
      ...times,
    },
    phasePlan,
  };
  return { summary, resolved, ctx, partial };
}

/** evaluate with no service-metrics file (unless given). */
function evaluate(ctx, partial, serviceMetrics = null) {
  return evaluateCollector(ctx, partial, { readServiceMetrics: () => serviceMetrics });
}

/** The full result.json the runner would write, built by the real result builder. */
function fullResult(fixture, evaluation, { resolved, summary, ctx }) {
  return buildResult({
    context: {
      runId: 'fixture01',
      service: 'cce-collector-service',
      subject: 'collector',
      testType: ctx.phasePlan.testType,
      startedAt: summary.context.k6StartedAt,
    },
    settings: resolved,
    phasePlan: ctx.phasePlan,
    k6Summary: summary,
    moduleEvaluation: evaluation,
    expectation: collector.expectation({
      testType: ctx.phasePlan.testType,
      settings: ctx.settings,
    }),
    module: collector,
    k6ExitCode: 0,
    timings: {
      k6ExitedAt: new Date(
        Date.parse(summary.context.k6StartedAt) + summary.state.testRunDurationMs,
      ).toISOString(),
    },
  });
}

describe('fixtures are still in step with lib/ and defaults.json', () => {
  for (const [fixture, testType] of Object.entries(FIXTURES)) {
    it(`${fixture}: its phase plan equals what resolveSettings gives today`, () => {
      assert.deepEqual(readFixture(fixture).context.phasePlan, fixtureSettings(testType).phasePlan);
    });
  }
});

describe('evaluate: load', () => {
  it('passing load: throughput rule passed, no k6 limit, processed = stored', () => {
    const s = setup('k6-summary-load-passed.json', {
      dataChecks: [{ id: 'collector.stored-equals-accepted', actual: 620, passed: true }],
    });
    const out = evaluate(s.ctx, s.partial);
    assert.equal(out.breaking.k6Limited, false);
    assert.equal(out.thresholds.length, 1);
    const [throughput] = out.thresholds;
    assert.equal(throughput.id, 'collector.throughput');
    assert.equal(throughput.actual, 10); // 600 accepted / 60 s
    assert.equal(throughput.limit, 9.5); // (1 − 0.05) × 10/s
    assert.equal(throughput.passed, true);
    assert.equal(throughput.source, 'k6');
    assert.equal(throughput.toBeConfirmed, true);
    assert.equal(out.load.eventsProcessed, 620);
    assert.deepEqual(out.notes, []);
  });

  it('a whole passing result validates against the result schema', () => {
    const s = setup('k6-summary-load-passed.json');
    const result = fullResult('k6-summary-load-passed.json', evaluate(s.ctx, s.partial), s);
    assert.deepEqual(validateResult(result), []);
    assert.equal(result.status, 'passed');
  });

  it('only dropped iterations failed while p95 stayed low: k6 limit, not a service failure', () => {
    const s = setup('k6-summary-load-k6-limited.json');
    const out = evaluate(s.ctx, s.partial);
    assert.equal(out.breaking.k6Limited, true);
    assert.match(out.notes.join(' '), /k6 limit/);
    const result = fullResult('k6-summary-load-k6-limited.json', out, s);
    assert.deepEqual(validateResult(result), []);
    assert.equal(result.status, 'failed');
    assert.match(result.statusReason, /k6 could not send 11 on time .*not a service failure/);
  });

  it('too few accepted events per second fails the throughput rule', () => {
    const s = setup('k6-summary-load-passed.json');
    s.partial.k6Summary.metrics['events_accepted{scenario:measure}'].values.count = 500;
    const [throughput] = evaluate(s.ctx, s.partial).thresholds;
    assert.equal(throughput.passed, false);
    assert.equal(throughput.informational, undefined);
    const result = fullResult('k6-summary-load-passed.json', evaluate(s.ctx, s.partial), s);
    assert.deepEqual(validateResult(result), []);
    assert.equal(result.status, 'failed');
  });

  it('with the k6 limit, a throughput shortfall is informational (the load generator could not send)', () => {
    const s = setup('k6-summary-load-k6-limited.json');
    s.partial.k6Summary.metrics['events_accepted{scenario:measure}'].values.count = 500;
    const [throughput] = evaluate(s.ctx, s.partial).thresholds;
    assert.equal(throughput.passed, false);
    assert.equal(throughput.informational, true);
    assert.match(throughput.description, /k6 limit/);
  });

  it('a run that ended early is judged over the time it really sent', () => {
    const s = setup('k6-summary-load-passed.json');
    const start = Date.parse(s.partial.times.measureStart);
    s.partial.times.sendEndedEarly = true;
    s.partial.times.sendEnd = new Date(start + 30_000).toISOString(); // stopped after 30 s
    const [throughput] = evaluate(s.ctx, s.partial).thresholds;
    assert.equal(throughput.actual, 20); // 600 / 30 s
  });

  it('notes the matcher backlog left and the server-side time per request', () => {
    const s = setup('k6-summary-load-passed.json', {
      dataChecks: [{ id: 'collector.downstream-backlog-left', actual: 1500, passed: false }],
    });
    const metrics = {
      samples: [
        {
          at: 'a',
          service: 'collector',
          metrics: {
            serverRequestSecondsSum: 10,
            serverRequestCount: 1000,
            serverRequestSecondsMax: 0.05,
          },
        },
        {
          at: 'b',
          service: 'collector',
          metrics: {
            serverRequestSecondsSum: 22,
            serverRequestCount: 1600,
            serverRequestSecondsMax: 0.09,
          },
        },
      ],
    };
    const notes = evaluate(s.ctx, s.partial, metrics).notes.join(' ');
    assert.match(notes, /still draining 1,500 events/);
    assert.match(notes, /average 20 ms, highest 90 ms/); // (22 − 10) / 600 s per request
  });

  it('server-side time needs two samples with requests in between', () => {
    assert.equal(serverSideTime(null), null);
    assert.equal(serverSideTime({ samples: [] }), null);
  });

  it('without a k6 summary there is nothing to evaluate (a note says so)', () => {
    const s = setup('k6-summary-load-passed.json');
    const out = evaluate(s.ctx, { ...s.partial, k6Summary: null });
    assert.deepEqual(out.thresholds, []);
    assert.match(out.notes[0], /No k6 summary/);
  });
});

describe('evaluate: breakpoint (staircase)', () => {
  it('held up to 20/s, broke at 40/s on p95; suggests --refine-from with this run', () => {
    const s = setup('k6-summary-breakpoint-broke.json');
    const out = evaluate(s.ctx, s.partial);
    assert.deepEqual(out.breaking, { k6Limited: false, heldUpTo: 20, brokeAtRate: 40 });
    assert.deepEqual(out.thresholds, []); // the verdict rule breakpoint.held-up-to comes from the builder
    assert.match(
      out.notes[0],
      /--refine-from results\/collector-breakpoint-20261105-100000 .*between 20\/s and 40\/s/,
    );
    const result = fullResult('k6-summary-breakpoint-broke.json', out, s);
    assert.deepEqual(validateResult(result), []);
    assert.equal(result.breaking.heldUpTo, 20);
    assert.equal(result.breaking.brokeAtRate, 40);
    assert.equal(result.levels.find((l) => l.rate === 80).result, 'not-reached');
  });

  it('k6 could not send 40/s while p95 was 15 ms: at least 20/s (k6 limit)', () => {
    const s = setup('k6-summary-breakpoint-k6-limited.json');
    const out = evaluate(s.ctx, s.partial);
    assert.deepEqual(out.breaking, { k6Limited: true, heldUpTo: 20, brokeAtRate: 40 });
    assert.match(out.notes[0], /k6 was the limit at 40\/s .*at least 20\/s/);
    const result = fullResult('k6-summary-breakpoint-k6-limited.json', out, s);
    assert.deepEqual(validateResult(result), []);
    assert.match(result.statusReason, /at least 20\/s \(k6 limit\)/);
  });
});

describe('baselineMetrics (plan §8.3)', () => {
  const base = {
    subject: 'collector',
    latency: { p95: 15.4 },
    load: { averageRate: 49.9 },
    breaking: { heldUpTo: 1600, brokeAtRate: 3200 },
  };

  it('load and stress: p95 and average rate', () => {
    for (const testType of ['load', 'stress']) {
      const metrics = collector.baselineMetrics({ ...base, testType });
      assert.deepEqual(
        metrics.map((m) => [m.key, m.unit, m.better, m.value]),
        [
          [`collector.${testType}.p95Ms`, 'ms', 'lower', 15.4],
          [`collector.${testType}.averageRate`, 'events/s', 'higher', 49.9],
        ],
      );
    }
  });

  it('breakpoint: held up to and broke at', () => {
    const metrics = collector.baselineMetrics({ ...base, testType: 'breakpoint' });
    assert.deepEqual(
      metrics.map((m) => [m.key, m.value]),
      [
        ['collector.breakpoint.heldUpTo', 1600],
        ['collector.breakpoint.brokeAtRate', 3200],
      ],
    );
  });

  it('smoke has no baseline metrics; missing values are null, never 0', () => {
    assert.deepEqual(collector.baselineMetrics({ ...base, testType: 'smoke' }), []);
    const metrics = collector.baselineMetrics({ subject: 'collector', testType: 'load' });
    assert.deepEqual(
      metrics.map((m) => m.value),
      [null, null],
    );
  });
});
