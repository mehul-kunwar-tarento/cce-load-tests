/**
 * result-builder.spec.mjs — unit tests of tools/core/result-builder.mjs (plan §5.2, §6.2).
 *
 * What:    result.json assembly: a seeded Step SLA run (PrepareResult times, plannedEvents, manifest, no k6),
 *          the v1 give-up bug case (not caught up → remainingBacklog, never a catch-up number), re-basing on
 *          k6StartedAt from the summary and an early k6 exit, the staircase capacity verdict, watcher aborts,
 *          missing summary → error, and de-duplication of thresholds by id (module wins).
 * How:     node --test tools/core/unit-tests/result-builder.spec.mjs
 * Needs:   lib/ pure modules; A1's breakpoint summary fixture (skipped when absent).
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { readJsonFile } from '../json-file.mjs';
import { repoPath } from '../paths.mjs';
import { buildResult, computeStatus } from '../result-builder.mjs';
import { validateResult } from '../result-schema.mjs';
import { resolveSettings } from '../settings.mjs';
import { localEnvironment } from './helpers.mjs';

const environment = localEnvironment();
const NOW = new Date('2026-11-05T14:22:33+05:30');

/** Resolved settings + phase plan + run context for a subject/test type. */
function setupFor(subject, testType, breakpointKind, overrides = {}) {
  const settings = resolveSettings({
    environment,
    subject,
    testType,
    breakpointKind,
    overrides: { RUN_ID: '20261105-142233', ...overrides },
    env: {},
    now: NOW,
  });
  const context = {
    runId: '20261105-142233',
    service: `cce-${subject}-service`,
    subject,
    testType,
    startedAt: '2026-11-05T14:22:33.000+05:30',
    dataset: null,
  };
  return { settings, phasePlan: settings.derived.phasePlan, context };
}

test('seeded Step SLA run: times from PrepareResult (source seed), planned alarms, manifest, no k6 fields', () => {
  const { settings, phasePlan, context } = setupFor('step-sla', 'load', 'none', {
    LOAD_EVENTS: '3000',
  });
  const prepareResult = {
    measureStart: '2026-11-05T14:24:00.000+05:30',
    sendEnd: '2026-11-05T14:25:00.000+05:30',
    plannedEvents: 3000,
    manifestFile: 'seed.json',
  };
  const result = buildResult({
    context,
    settings,
    phasePlan,
    module: { kind: 'seeded', breakpointKind: 'none' },
    expectation: {
      summary: 'Handle 50 alarms/s',
      targetRate: 50,
      peakRate: 50,
      multipleOfPeak: 1,
      unit: 'alarms',
      toBeConfirmed: true,
    },
    watcherOutcomes: [
      {
        name: 'alarms',
        file: '/x/watch-alarms.json',
        samples: [],
        thresholds: [],
        breaking: { caughtUp: true, catchUpSeconds: 4 },
        load: { eventsProcessed: 3000 },
        peaks: { slaCycleCapHits: { value: 0, firstAt: null } },
        subject: 'step-sla',
      },
    ],
    dataChecks: [
      {
        id: 'step-sla.all-handled',
        description: 'all handled',
        expected: 3000,
        actual: 3000,
        comparison: 'equals',
        passed: true,
        severity: 'required',
      },
    ],
    timings: {
      prepareResult,
      endedAt: '2026-11-05T14:26:00.000+05:30',
      watchersEndedAt: '2026-11-05T14:25:04.000+05:30',
    },
  });
  assert.deepEqual(validateResult(result), []);
  assert.equal(result.status, 'passed');
  assert.equal(result.timing.source, 'seed');
  assert.equal(result.timing.k6StartedAt, null);
  assert.equal(result.load.unit, 'alarms');
  assert.equal(result.load.plannedEvents, 3000);
  assert.equal(result.load.eventsProcessed, 3000);
  // "Went through" = alarms handled, over the ring interval plus the catch-up (events-through.mjs).
  assert.equal(result.load.eventsThrough, 3000);
  assert.equal(result.load.throughBasis, 'handled');
  assert.equal(result.load.throughSeconds, result.load.measuredSeconds + 4);
  assert.equal(result.load.eventsDropped, null, 'no k6, no dropped iterations');
  assert.equal(result.latency, null);
  assert.equal(result.artifacts.seedManifest, 'seed.json');
  assert.equal(result.artifacts.k6Summary, null);
  assert.equal(result.serviceMetrics.peaks['step-sla'].slaCycleCapHits.value, 0);
  assert.deepEqual(
    result.phases.map((p) => p.name),
    ['measure', 'catch-up'],
  );
  assert.equal(result.phases[0].plannedEvents, 3000);
});

test('v1 give-up bug case: not caught up → caughtUp false, remainingBacklog, catchUpSeconds null', () => {
  const { settings, phasePlan, context } = setupFor('matcher', 'stress', 'flood');
  const result = buildResult({
    context,
    settings,
    phasePlan,
    module: { kind: 'k6' },
    k6Summary: {
      metrics: {
        events_sent: { values: { count: 120598 } },
        dropped_iterations: { values: { count: 2 }, thresholds: { 'count<=120': { ok: true } } },
      },
      context: { k6StartedAt: '2026-11-05T08:52:40.000Z' },
    },
    watcherOutcomes: [
      {
        name: 'backlog',
        file: '/r/watch-backlog.json',
        samples: [],
        thresholds: [
          {
            id: 'matcher.catch-up',
            metric: 'catchUpSeconds',
            rule: 'caught up within 30 s',
            limit: 30,
            actual: null,
            unit: 's',
            passed: false,
            toBeConfirmed: true,
            source: 'watcher',
            description: 'Caught up within 30 s after sending stopped',
          },
        ],
        breaking: {
          caughtUp: false,
          catchUpSeconds: null,
          remainingBacklog: 11474,
          gaveUpAfterSeconds: 120,
          whatBroke: [
            {
              metric: 'catchUpSeconds',
              description: 'not caught up: 11,474 events still waiting after 120 s',
              actual: 11474,
              limit: 30,
              source: 'watcher',
            },
          ],
        },
        load: {},
      },
    ],
    timings: { endedAt: '2026-11-05T14:36:00.000+05:30' },
  });
  assert.deepEqual(validateResult(result), []);
  assert.equal(result.status, 'failed');
  assert.equal(result.breaking.caughtUp, false);
  assert.equal(result.breaking.catchUpSeconds, null);
  assert.equal(result.breaking.remainingBacklog, 11474);
  assert.equal(result.breaking.gaveUpAfterSeconds, 120);
  assert.match(result.statusReason, /Caught up within 30 s/);
  // The v1 shape (a give-up time as catch-up) is rejected by the validator.
  assert.ok(
    validateResult({ ...result, breaking: { ...result.breaking, catchUpSeconds: 121.4 } }).some(
      (p) => /catchUpSeconds must be null/.test(p),
    ),
  );
});

test('times are re-based on k6StartedAt from the summary; an early k6 exit ends sending early', () => {
  const { settings, phasePlan, context } = setupFor('stub', 'load', 'staircase');
  const k6Summary = {
    metrics: {
      events_sent: { values: { count: 900 } },
      'events_sent{scenario:measure}': { values: { count: 300 } },
    },
    context: { k6StartedAt: '2026-11-05T08:52:40.000Z' },
  };
  const times = {
    k6StartedAt: '2026-11-05T14:22:41.000+05:30',
    source: 'k6-rest-api',
    warnings: [],
  };
  const result = buildResult({
    context,
    settings,
    phasePlan,
    module: { kind: 'k6' },
    k6Summary,
    timings: {
      times,
      k6ExitedAt: '2026-11-05T14:23:46.000+05:30',
      endedAt: '2026-11-05T14:24:00.000+05:30',
    },
  });
  assert.equal(result.timing.source, 'k6-setup', 'summary wins over the live REST value');
  assert.equal(new Date(result.timing.k6StartedAt).toISOString(), '2026-11-05T08:52:40.000Z');
  assert.equal(
    new Date(result.timing.measureStart).toISOString(),
    '2026-11-05T08:53:40.000Z',
    'after the 60 s warm-up',
  );
  assert.equal(result.timing.sendEndedEarly, true);
  assert.equal(result.load.measuredSeconds, 6);
  assert.equal(result.load.measuredEventsSent, 300);
  assert.equal(result.load.averageRate, 50);
  assert.equal(result.load.eventsSent, 900, 'all phases');
});

test('no k6-summary.json from a k6 test → status error (the tool could not produce a verdict)', () => {
  const { settings, phasePlan, context } = setupFor('stub', 'smoke', 'staircase');
  const result = buildResult({
    context,
    settings,
    phasePlan,
    module: { kind: 'k6' },
    k6ExitCode: 1,
    timings: { endedAt: NOW },
  });
  assert.equal(result.status, 'error');
  assert.match(result.statusReason, /no k6-summary\.json \(exit code 1\)/);
  assert.deepEqual(validateResult(result), []);
});

test('a watcher abort (stall) makes the run aborted, keeping partial data', () => {
  const { settings, phasePlan, context } = setupFor('matcher', 'load', 'flood');
  const result = buildResult({
    context,
    settings,
    phasePlan,
    module: { kind: 'k6' },
    k6Summary: { metrics: { events_sent: { values: { count: 10 } } } },
    watcherOutcomes: [
      {
        name: 'backlog',
        samples: [],
        thresholds: [],
        breaking: {},
        load: {},
        aborted: 'stalled: no progress for 30 s',
      },
    ],
    timings: { endedAt: NOW },
  });
  assert.equal(result.status, 'aborted');
  assert.match(result.statusReason, /stalled: no progress for 30 s/);
});

test('thresholds are de-duplicated by id: a module rule replaces a watcher rule with the same id', () => {
  const { settings, phasePlan, context } = setupFor('matcher', 'load', 'flood');
  const rule = (passed, source) => ({
    id: 'matcher.backlog',
    metric: 'backlog',
    rule: 'max < 1000',
    limit: 1000,
    actual: 5,
    unit: 'events',
    passed,
    toBeConfirmed: true,
    source,
    description: 'backlog',
  });
  const result = buildResult({
    context,
    settings,
    phasePlan,
    module: { kind: 'k6' },
    k6Summary: { metrics: {} },
    watcherOutcomes: [
      { name: 'b', samples: [], thresholds: [rule(false, 'watcher')], breaking: {}, load: {} },
    ],
    moduleEvaluation: { thresholds: [rule(true, 'watcher')] },
    timings: { endedAt: NOW },
  });
  assert.equal(result.thresholds.filter((t) => t.id === 'matcher.backlog').length, 1);
  assert.equal(result.thresholds.find((t) => t.id === 'matcher.backlog').passed, true);
});

const BREAKPOINT = repoPath('lib/unit-tests/fixtures/k6-summary-breakpoint.json');

test(
  'staircase: per-level rules find the break (informational); the verdict is held-up-to vs target',
  { skip: !fs.existsSync(BREAKPOINT) && 'A1 fixture missing' },
  () => {
    const k6Summary = readJsonFile(BREAKPOINT);
    const { settings, context } = setupFor('collector', 'breakpoint', 'staircase');
    const make = (targetRate) =>
      buildResult({
        context,
        settings,
        phasePlan: k6Summary.context.phasePlan,
        module: { kind: 'k6' },
        k6Summary,
        k6ExitCode: 99,
        expectation: {
          summary: 'hold',
          targetRate,
          peakRate: 50,
          multipleOfPeak: targetRate / 50,
          unit: 'events',
          toBeConfirmed: true,
        },
        timings: {
          k6ExitedAt: '2026-11-05T14:28:07.000+05:30',
          endedAt: '2026-11-05T14:28:20.000+05:30',
        },
      });
    const passed = make(200);
    assert.deepEqual(validateResult(passed), []);
    assert.equal(passed.status, 'passed');
    assert.match(passed.statusReason, /Held up to 1,600\/s, broke at 3,200\/s/);
    assert.ok(
      passed.thresholds.filter((t) => /level:/.test(t.metric)).every((t) => t.informational),
    );
    assert.equal(passed.breaking.heldUpTo, 1600);
    assert.equal(passed.levels.length, 6);
    const failed = make(2000);
    assert.equal(failed.status, 'failed');
    assert.match(failed.statusReason, /Staircase held at least 2,000\/s/);
  },
);

test('computeStatus: k6 limit wording when only the load generator failed', () => {
  const verdict = computeStatus({
    thresholds: [{ id: 'k6.dropped_iterations', passed: false, description: 'dropped' }],
    dataChecks: [],
    breaking: {
      k6Limited: true,
      whatBroke: [
        {
          metric: 'k6-limit',
          description: 'k6 could not send 11 on time (k6 limit, service p95 20 ms)',
        },
      ],
    },
  });
  assert.equal(verdict.status, 'failed');
  assert.match(verdict.statusReason, /load-generator limit, not a service failure/);
  assert.equal(
    computeStatus({
      thresholds: [],
      dataChecks: [{ passed: false, severity: 'info' }],
      breaking: {},
    }).status,
    'passed',
    'info checks never fail a run',
  );
});
