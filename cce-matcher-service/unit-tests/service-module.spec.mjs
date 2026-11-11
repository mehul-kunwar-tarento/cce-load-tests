/**
 * service-module.spec.mjs — unit tests of the matcher's service module (plan §6.4) and its k6 options.
 *
 * What:    Checks the plug-in contract without running anything: the registry accepts the module; every
 *          test type points at an existing k6 script inside this folder (module-relative URL); the
 *          expectation sentences carry the default numbers; the sampled metrics fit the shared sampler;
 *          waitForIdle is the shared matcher idle helper (and waits / refuses on a fake clock); the watcher
 *          factory; evaluate (module rules only, watcher rules passed through, notes); baselineMetrics
 *          (plan §8.3 keys, never a catch-up number when not caught up); the Kafka VU limits of the flood
 *          (100 / 500) and of the other tests; and the generic-name rule (no dataset name in identifiers).
 * How:     npm test   (or: node --test cce-matcher-service/unit-tests/service-module.spec.mjs)
 * Needs:   ../service-module.mjs, ../shared.mjs, ./fakes.mjs. No network, no database, no Docker.
 * Outputs: node:test results.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import matcher, {
  PROCESSING_ALERT_MS,
  SAMPLED_METRICS,
  TEST_TYPES,
  buildExpectation,
  evaluateMatcherRun,
  matcherBaselineMetrics,
} from '../service-module.mjs';
import {
  COMMON_SAMPLED_METRICS,
  PEAK_SIGNALS,
  buildOptions,
  validateServiceModule,
  waitForMatcherIdle,
} from '../shared.mjs';
import {
  ENVIRONMENT,
  createFakeClock,
  createFakeKafkaAdmin,
  createFakeScrape,
  defaultSettings,
  phasePlanFor,
} from './fakes.mjs';

/** Absolute path of the cce-matcher-service folder (one level up from unit-tests/). */
const FOLDER = fileURLToPath(new URL('..', import.meta.url));

describe('matcher service module: shape', () => {
  it('passes the registry shape check', () => {
    assert.deepEqual(validateServiceModule(matcher), []);
  });

  it('has the identity and requirements of plan §2.1 and §6.4', () => {
    assert.equal(matcher.service, 'cce-matcher-service');
    assert.equal(matcher.subject, 'matcher');
    assert.equal(matcher.idCode, 'mat');
    assert.equal(matcher.displayName, 'Matcher');
    assert.equal(matcher.kind, 'k6');
    assert.equal(matcher.breakpointKind, 'flood');
    assert.deepEqual(matcher.testTypes, ['smoke', 'load', 'stress', 'breakpoint']);
    assert.deepEqual(matcher.requires, {
      services: ['matcher'],
      postgres: true,
      kafka: true,
      protocol: true,
    });
    assert.equal(matcher.prepare, undefined, 'the matcher is fed by k6, nothing is seeded');
  });

  for (const testType of TEST_TYPES) {
    it(`testFile(${testType}) is a module-relative URL of an existing script that asserts its type`, () => {
      const url = matcher.testFile(testType);
      assert.ok(url instanceof URL);
      assert.equal(url.protocol, 'file:');
      const file = fileURLToPath(url);
      assert.ok(file.startsWith(FOLDER), `${file} is outside ${FOLDER}`);
      assert.ok(file.endsWith(`/tests/matcher-${testType}.test.js`));
      const source = fs.readFileSync(file, 'utf8');
      // Thin test: the shared scenario for its own type, setup = markK6Start, handleSummary = writeSummary.
      assert.match(source, new RegExp(`createMatcherTest\\('${testType}'\\)`));
      assert.match(source, /return markK6Start\(\)/);
      assert.match(source, /return matcher\.writeSummary\(data\)/);
      assert.match(source, /export const options = matcher\.options/);
    });
  }

  it('the shared scenario builds Kafka options and keys each message by patient id', () => {
    const source = fs.readFileSync(path.join(FOLDER, 'tests/matcher-scenario.js'), 'utf8');
    assert.match(source, /buildOptions\(\{ context, kind: 'kafka' \}\)/);
    assert.match(
      source,
      /produceEvent\(producer, \{ key: patientId, value: JSON\.stringify\(cloudEvent\) \}\)/,
    );
    assert.match(source, /recordSend\(handed\)/);
    assert.match(source, /tagIteration\(context\)/);
  });

  it('declares one watcher factory that builds the backlog watcher', () => {
    assert.equal(matcher.watchers.length, 1);
    const watcher = matcher.watchers[0]({
      settings: defaultSettings(),
      phasePlan: phasePlanFor('load'),
      resultsDir: '/fake',
      environment: ENVIRONMENT,
      times: { ready: new Promise(() => {}) },
    });
    assert.equal(watcher.name, 'backlog');
    for (const method of ['start', 'stop', 'whenDone'])
      assert.equal(typeof watcher[method], 'function');
  });
});

describe('matcher service module: sampled metrics', () => {
  it('uses plain metric names, exact labels, sum/max and keys unique next to the common ones', () => {
    const commonKeys = new Set(COMMON_SAMPLED_METRICS.map((m) => m.key));
    const keys = new Set();
    for (const metric of SAMPLED_METRICS) {
      assert.match(
        metric.name,
        /^[a-z_]+$/,
        `${metric.key}: plain metric name, no braces or wildcards`,
      );
      assert.ok(['sum', 'max'].includes(metric.agg), metric.key);
      assert.ok(metric.unit, metric.key);
      assert.ok(!commonKeys.has(metric.key), `${metric.key} clashes with a common key`);
      assert.ok(!keys.has(metric.key), `${metric.key} twice`);
      keys.add(metric.key);
      for (const value of Object.values(metric.labels ?? {})) assert.doesNotMatch(value, /[*~|]/);
    }
    assert.equal(matcher.sampledMetrics, SAMPLED_METRICS);
  });

  it('provides the keys the processingMsAvg peak is computed from', () => {
    const peak = PEAK_SIGNALS.find((p) => p.peakKey === 'processingMsAvg');
    for (const key of peak.sampled)
      assert.ok(
        SAMPLED_METRICS.some((m) => m.key === key),
        key,
      );
  });

  it('samples both cce_events_matched_total series and never cce_events_processed_total (counts retries)', () => {
    const matched = SAMPLED_METRICS.filter((m) => m.name === 'cce_events_matched_total');
    assert.deepEqual(matched.map((m) => m.labels.status).sort(), ['matched', 'zero_match']);
    assert.ok(!SAMPLED_METRICS.some((m) => m.name === 'cce_events_processed_total'));
  });
});

describe('matcher service module: expectation', () => {
  const settings = defaultSettings();
  const single = { name: 'emr-service', fanOut: 1, effectiveFanOut: 1 };

  it('load: 50 events/s for 10 min, 1 × peak, with the rules in words', () => {
    const e = matcher.expectation({
      testType: 'load',
      settings,
      environment: ENVIRONMENT,
      planDefinitionSet: single,
    });
    assert.equal(e.targetRate, 50);
    assert.equal(e.peakRate, 50);
    assert.equal(e.multipleOfPeak, 1);
    assert.equal(e.unit, 'events');
    assert.equal(e.toBeConfirmed, true);
    assert.match(e.summary, /Withstand 50 events\/s \(1 × peak 50\/s\) for 10m 0s with/);
    assert.match(e.summary, /set emr-service \(1 plan definition per event\)/);
    assert.match(e.summary, /backlog never above 1,000 events, caught up within 30s/);
  });

  it('stress: 200 events/s = 4 × peak; overlapping-4 is named with its fan-out', () => {
    const e = buildExpectation({
      testType: 'stress',
      settings,
      planDefinitionSet: { name: 'overlapping-4', fanOut: 4, effectiveFanOut: 4 },
    });
    assert.equal(e.targetRate, 200);
    assert.equal(e.multipleOfPeak, 4);
    assert.match(e.summary, /4 plan definitions per event/);
  });

  it('breakpoint (flood): drain 120,000 events at ≥ EXPECTED_HEADROOM × peak', () => {
    const e = buildExpectation({ testType: 'breakpoint', settings, planDefinitionSet: single });
    assert.equal(e.targetRate, 200);
    assert.equal(e.multipleOfPeak, 4);
    assert.match(
      e.summary,
      /Drain a flood of 120,000 events \(2,000\/s for 1m 0s\) at ≥ 200 events\/s/,
    );
  });

  it('smoke, and every limit read from the settings (an override shows up)', () => {
    const e = buildExpectation({
      testType: 'smoke',
      settings: defaultSettings({ MATCHER_MAX_BACKLOG: 250 }),
      planDefinitionSet: null,
    });
    assert.equal(e.targetRate, 1);
    assert.match(e.summary, /^Smoke: 1 event\/s for 30s/);
    assert.match(e.summary, /never above 250 events/);
    assert.throws(() => buildExpectation({ testType: 'soak', settings }), /no soak test/);
  });
});

describe('matcher service module: waitForIdle', () => {
  /** A ctx whose lag and processed counter follow scripts on a fake clock. */
  function idleCtx({ lagAt, countersAt, clock }) {
    return {
      environment: ENVIRONMENT,
      settings: defaultSettings(),
      kafkaAdmin: createFakeKafkaAdmin({ lagAt, clock }),
      scrape: createFakeScrape({ countersAt, clock }),
    };
  }

  it('is the shared helper itself (the collector waits the same way)', () => {
    assert.equal(matcher.waitForIdle, waitForMatcherIdle);
  });

  it('returns once lag is 0 and the processed counter stayed flat for IDLE_FLAT_DURATION', async () => {
    const clock = createFakeClock();
    // A previous run still draining for 40 s, then idle.
    const ctx = idleCtx({
      clock,
      lagAt: (s) => (s < 40 ? 400 - s * 10 : 0),
      countersAt: (s) => ({ matched: Math.round(Math.min(s, 40) * 10) }),
    });
    const { waitedSeconds } = await matcher.waitForIdle(ctx, {
      now: clock.now,
      sleep: clock.sleep,
    });
    assert.ok(waitedSeconds >= 70 && waitedSeconds <= 80, `waited ${waitedSeconds} s`);
  });

  it('refuses (exit 2) after IDLE_TIMEOUT when the matcher never becomes idle', async () => {
    const clock = createFakeClock();
    const ctx = idleCtx({ clock, lagAt: () => 5, countersAt: (s) => ({ matched: Math.round(s) }) });
    await assert.rejects(
      matcher.waitForIdle(ctx, { now: clock.now, sleep: clock.sleep }),
      (error) => error.name === 'RefusedError' && /IDLE_TIMEOUT/.test(error.message),
    );
  });
});

describe('matcher service module: evaluate', () => {
  /** A watcher outcome as the backlog watcher returns it (only what evaluate reads). */
  const outcome = (summary = {}, extra = {}) => ({
    name: 'backlog',
    thresholds: [
      { id: 'matcher.backlog', metric: 'backlog', passed: true, source: 'watcher' },
      { id: 'matcher.catch-up', metric: 'catchUpSeconds', passed: true, source: 'watcher' },
    ],
    summary: { processingMsAvg: 4.2, processingMaxMs: 120, sendEndedEarly: false, ...summary },
    warnings: [],
    ...extra,
  });
  const ctx = { phasePlan: phasePlanFor('load') };

  it('passes the watcher rules through (same ids) and adds the informational processing-time rule', () => {
    const result = matcher.evaluate(ctx, { watcherOutcomes: [outcome()] });
    assert.deepEqual(
      result.thresholds.map((t) => t.id),
      ['matcher.backlog', 'matcher.catch-up', 'matcher.processing-time'],
    );
    const time = result.thresholds.at(-1);
    assert.equal(time.informational, true);
    assert.equal(time.limit, PROCESSING_ALERT_MS);
    assert.equal(time.actual, 120);
    assert.equal(time.passed, true);
    assert.equal(time.toBeConfirmed, true);
    assert.ok(result.notes.some((n) => /4\.2 ms per event/.test(n)));
    assert.ok(result.notes.some((n) => /handed to the producer/.test(n)));
    assert.deepEqual(result.breaking, {});
    assert.deepEqual(result.load, {});
  });

  it('a slow event fails the informational rule only (never the verdict)', () => {
    const result = evaluateMatcherRun(ctx, {
      watcherOutcomes: [outcome({ processingMaxMs: 812 })],
    });
    const time = result.thresholds.find((t) => t.id === 'matcher.processing-time');
    assert.equal(time.passed, false);
    assert.equal(time.informational, true);
  });

  it('without a watcher outcome (or with a failed watcher) the run cannot pass', () => {
    for (const watcherOutcomes of [[], [{ name: 'backlog', error: 'kafka admin refused' }]]) {
      const result = evaluateMatcherRun(ctx, { watcherOutcomes });
      const rule = result.thresholds.find((t) => t.id === 'matcher.backlog-watcher');
      assert.equal(rule.passed, false);
      assert.notEqual(rule.informational, true);
    }
  });

  it('notes an early send end, watcher warnings and, for the flood, what dropped iterations mean', () => {
    const result = evaluateMatcherRun(
      { phasePlan: phasePlanFor('breakpoint') },
      {
        watcherOutcomes: [outcome({ sendEndedEarly: true }, { warnings: ['scrape failed once'] })],
      },
    );
    assert.ok(result.notes.some((n) => /stopped sending before the planned end/.test(n)));
    assert.ok(result.notes.some((n) => /Backlog watcher: scrape failed once/.test(n)));
    assert.ok(result.notes.some((n) => /Flood: dropped iterations/.test(n)));
  });
});

describe('matcher service module: baselineMetrics (plan §8.3)', () => {
  /** A minimal result.json of a matcher run. */
  const result = (
    testType,
    { breaking = {}, thresholds = [], points = [], measuredSeconds = 600 } = {},
  ) => ({
    testType,
    breaking,
    thresholds,
    timeSeries: { windowSeconds: 10, points },
    load: { measuredSeconds },
    serviceMetrics: { peaks: { matcher: { processingMsAvg: { value: 4.2, firstAt: null } } } },
  });
  const value = (metrics, key) => metrics.find((m) => m.key === key)?.value;

  it('load: max backlog, catch-up seconds and processing time', () => {
    const metrics = matcher.baselineMetrics(
      result('load', {
        breaking: { caughtUp: true, catchUpSeconds: 6.5 },
        thresholds: [{ id: 'matcher.backlog', actual: 140 }],
      }),
    );
    assert.deepEqual(
      metrics.map((m) => m.key),
      ['matcher.load.maxBacklog', 'matcher.load.catchUpSeconds', 'matcher.load.processingMsAvg'],
    );
    assert.equal(value(metrics, 'matcher.load.maxBacklog'), 140);
    assert.equal(value(metrics, 'matcher.load.catchUpSeconds'), 6.5);
    assert.equal(value(metrics, 'matcher.load.processingMsAvg'), 4.2);
    for (const metric of metrics) {
      assert.ok(metric.label && metric.unit);
      assert.ok(['lower', 'higher'].includes(metric.better));
    }
  });

  it('never returns a catch-up number for a run that did not catch up (v1 bug, D19)', () => {
    const metrics = matcherBaselineMetrics(
      result('load', {
        breaking: { caughtUp: false, catchUpSeconds: 121.4, gaveUpAfterSeconds: 121.4 },
      }),
    );
    assert.equal(value(metrics, 'matcher.load.catchUpSeconds'), null);
  });

  it('stress: processed per second over the measured phase, max backlog, seconds to break', () => {
    const metrics = matcherBaselineMetrics(
      result('stress', {
        breaking: { secondsIntoMeasure: 25 },
        // Two measured points and one catch-up point after the measured phase (not counted).
        points: [
          { t: 0, backlog: 500, processedPerSecond: 150 },
          { t: 10, backlog: 28810, processedPerSecond: 140 },
          { t: 610, backlog: 20000, processedPerSecond: 300 },
        ],
      }),
    );
    assert.deepEqual(
      metrics.map((m) => m.key),
      [
        'matcher.stress.processedPerSecond',
        'matcher.stress.maxBacklog',
        'matcher.stress.secondsToBreak',
        'matcher.stress.processingMsAvg',
      ],
    );
    assert.equal(value(metrics, 'matcher.stress.processedPerSecond'), 145);
    assert.equal(
      value(metrics, 'matcher.stress.maxBacklog'),
      28810,
      'from the series when no rule',
    );
    assert.equal(value(metrics, 'matcher.stress.secondsToBreak'), 25);
  });

  it('breakpoint: the drain rate; smoke: nothing', () => {
    const flood = matcherBaselineMetrics(result('breakpoint', { breaking: { drainRate: 312.4 } }));
    assert.deepEqual(flood, [
      {
        key: 'matcher.breakpoint.drainRate',
        label: 'Matcher breakpoint drain rate',
        unit: 'events/s',
        better: 'higher',
        value: 312.4,
      },
    ]);
    assert.deepEqual(matcherBaselineMetrics(result('smoke')), []);
  });
});

describe('matcher k6 options: Kafka VU limits (plan §4.3)', () => {
  /** k6 options as a test file builds them, from a run context of the given type. */
  const optionsFor = (testType, overrides = {}) => {
    const settings = defaultSettings(overrides);
    return buildOptions({
      context: {
        runId: settings.RUN_ID,
        subject: 'matcher',
        testType,
        settings,
        phasePlan: phasePlanFor(testType, settings),
        planDefinitionSet: { name: 'emr-service' },
        environment: { name: 'local' },
      },
      kind: 'kafka',
    });
  };

  it('flood: 100 producers ready, up to 500 (KAFKA_PRE_ALLOCATED_VUS / KAFKA_MAX_VUS, not MAX_VUS)', () => {
    const { scenarios, thresholds, tags } = optionsFor('breakpoint');
    assert.equal(scenarios.measure.executor, 'constant-arrival-rate');
    assert.equal(scenarios.measure.rate, 2000);
    assert.equal(scenarios.measure.preAllocatedVUs, 100);
    assert.equal(scenarios.measure.maxVUs, 500);
    assert.ok(thresholds.kafka_writer_error_count.includes('count<=0'));
    assert.equal(tags.service, 'matcher');
    assert.equal(tags.test_type, 'breakpoint');
  });

  it('load and stress stay well inside the limits; overrides apply', () => {
    assert.deepEqual(
      [
        optionsFor('load').scenarios.measure.preAllocatedVUs,
        optionsFor('load').scenarios.measure.maxVUs,
      ],
      [25, 200],
    );
    assert.equal(optionsFor('stress').scenarios.measure.maxVUs, 500);
    const custom = optionsFor('breakpoint', { KAFKA_PRE_ALLOCATED_VUS: 50, KAFKA_MAX_VUS: 300 });
    assert.equal(custom.scenarios.measure.preAllocatedVUs, 50);
    assert.equal(custom.scenarios.measure.maxVUs, 300);
  });
});

describe('matcher folder: generic names (plan §2.1)', () => {
  // The dataset's name is built here so that this file itself passes the repository-wide grep.
  const word = ['e', 'buzima'].join('');

  /** Every file and folder below the matcher folder (relative paths). */
  function walk(dir = FOLDER, found = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      found.push(path.relative(FOLDER, full));
      if (entry.isDirectory()) walk(full, found);
    }
    return found;
  }

  it('no file or folder name carries the dataset name', () => {
    assert.deepEqual(
      walk().filter((p) => p.toLowerCase().includes(word)),
      [],
    );
  });

  it('code mentions the dataset only as its value (ebuzima-emr style), never in an identifier', () => {
    const offenders = [];
    for (const file of walk().filter((p) => /\.(m?js|json)$/.test(p) && !p.includes('fixtures'))) {
      fs.readFileSync(path.join(FOLDER, file), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (line.toLowerCase().includes(word) && !line.toLowerCase().includes(`${word}-emr`))
            offenders.push(`${file}:${i + 1}`);
        });
    }
    assert.deepEqual(offenders, []);
  });
});
