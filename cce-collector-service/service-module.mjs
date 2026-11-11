/**
 * service-module.mjs — how the shared runner tests cce-collector-service (the plug-in of plan §6.4).
 *
 * What:    The runner (node tools/cli.mjs run <env> collector <test-type>) is the same for every service;
 *          this object tells it what is special about the collector: its identity (subject "collector",
 *          id code "col"), the k6 script of each test type, what we expect it to withstand (1 × peak for
 *          load, 4 × peak for stress and breakpoint — to be confirmed from UAT/Dev data), that it must wait
 *          for the matcher to be idle first (every collector event also feeds the matcher, and both share
 *          Postgres), which actuator metrics to sample, the data checks, the collector's own pass rule
 *          (events accepted per second) and the numbers worth keeping in a baseline.
 * How:     Found automatically by tools/core/service-registry.mjs; e.g.
 *            scripts/run-test.sh local collector load
 *            node tools/cli.mjs run local collector breakpoint --dry-run
 * Needs:   ./shared.mjs (the shared tooling), tests/collector-<type>.test.js, data-checks/; at run time the
 *          ctx built by the runner (settings, phase plan, Postgres pool, Kafka admin, scrape, times).
 * Outputs: The service module object (default export); named exports for unit tests.
 */
import path from 'node:path';
import { runCollectorDataChecks } from './data-checks/collector-data-checks.mjs';
import {
  analyseLevels,
  analyseWindows,
  formatDuration,
  formatNumber,
  formatPercent,
  measuredP95,
  measuredPhaseOf,
  metricValue,
  normaliseK6Summary,
  readJsonIfExists,
  waitForMatcherIdle,
} from './shared.mjs';

/** The four standard test types (plan §2.1); "breakpoint" is a staircase for HTTP services. */
export const TEST_TYPES = Object.freeze(['smoke', 'load', 'stress', 'breakpoint']);

/** The endpoint label of the server-side metrics (exact value; no wildcards in sampled metrics). */
const EVENTS_URI = '/v1/events';

/**
 * Collector metrics sampled every WATCH_INTERVAL on top of the common JVM/Hikari ones (plan §6.3).
 * Why: server-side time per request (sum/count/max: the collector exports no histogram buckets, so p95
 * comes only from k6), the collector's own counters, and Kafka publish failures (a PEAK_SIGNALS key).
 */
export const COLLECTOR_SAMPLED_METRICS = Object.freeze([
  {
    key: 'serverRequestSecondsSum',
    name: 'http_server_requests_seconds_sum',
    labels: { uri: EVENTS_URI },
    agg: 'sum',
    unit: 'seconds',
  },
  {
    key: 'serverRequestCount',
    name: 'http_server_requests_seconds_count',
    labels: { uri: EVENTS_URI },
    agg: 'sum',
    unit: 'requests',
  },
  {
    key: 'serverRequestSecondsMax',
    name: 'http_server_requests_seconds_max',
    labels: { uri: EVENTS_URI },
    agg: 'max',
    unit: 'seconds',
  },
  {
    key: 'eventsReceived',
    name: 'cce_collector_events_received_total',
    agg: 'sum',
    unit: 'events',
  },
  {
    key: 'eventsAccepted',
    name: 'cce_collector_events_accepted_total',
    agg: 'sum',
    unit: 'events',
  },
  {
    key: 'eventsDuplicate',
    name: 'cce_collector_events_duplicate_total',
    agg: 'sum',
    unit: 'events',
  },
  {
    // Key name fixed by PEAK_SIGNALS (tools/core/sampled-metrics.mjs) so it becomes a diagnostic peak.
    key: 'kafkaPublishFailures',
    name: 'cce_collector_kafka_publish_failure_total',
    agg: 'sum',
    unit: 'failures',
  },
]);

/**
 * What the collector is expected to withstand in each test type, in plain words (R1.3).
 * Why: every report puts this sentence next to the result ("expectation vs result").
 * @param {{testType:string, settings:Record<string, any>}} input settings = ResolvedSettings.values
 * @returns {{summary:string, targetRate:number, peakRate:number, multipleOfPeak:number, unit:'events', toBeConfirmed:boolean}}
 */
export function collectorExpectation({ testType, settings }) {
  const peak = settings.PEAK_RATE;
  // The pass rules every smoke/load/stress run is judged by (k6 thresholds, lib/thresholds.js).
  const rules =
    `p95 < ${formatNumber(settings.HTTP_P95_LIMIT_MS)} ms, failed < ${formatPercent(settings.HTTP_MAX_FAILED_RATE)}, ` +
    `checks > ${formatPercent(settings.MIN_CHECKS_RATE)}, dropped < ${formatPercent(settings.MAX_DROPPED_RATE)}`;
  const times = (rate) => formatNumber(rate / peak, 2); // "4" in "4 × peak"
  let targetRate;
  let summary;
  if (testType === 'smoke') {
    targetRate = settings.SMOKE_RATE;
    summary =
      `Smoke: ${formatNumber(targetRate)} events/s for ${formatDuration(settings.SMOKE_DURATION)}: every event ` +
      `answered 202 "accepted" and stored; ${rules}.`;
  } else if (testType === 'load' || testType === 'stress') {
    const prefix = testType === 'load' ? 'LOAD' : 'STRESS';
    targetRate = settings[`${prefix}_RATE`];
    summary =
      `Withstand ${formatNumber(targetRate)} events/s (${times(targetRate)} × peak ${formatNumber(peak)}/s) for ` +
      `${formatDuration(settings[`${prefix}_DURATION`])} after the warm-up: ${rules}; every accepted event stored.`;
  } else if (testType === 'breakpoint') {
    // Capacity target: EXPECTED_HEADROOM × peak; the staircase itself climbs until something breaks.
    targetRate = settings.EXPECTED_HEADROOM * peak;
    summary =
      `Hold at least ${formatNumber(targetRate)} events/s (${formatNumber(settings.EXPECTED_HEADROOM)} × peak ` +
      `${formatNumber(peak)}/s) on the staircase ${settings.LEVELS.map((l) => formatNumber(l)).join(' → ')}/s ` +
      `(${formatDuration(settings.LEVEL_DURATION)} per level); find the rate where it breaks.`;
  } else {
    throw new Error(`The collector has no ${testType} test (it has: ${TEST_TYPES.join(', ')})`);
  }
  return {
    summary,
    targetRate,
    peakRate: peak,
    multipleOfPeak: targetRate / peak,
    unit: 'events',
    toBeConfirmed: true, // PEAK_RATE, EXPECTED_HEADROOM and the limits are all "to be confirmed"
  };
}

/**
 * Seconds the measured phase really sent for: the planned duration, or less when k6 stopped early.
 * Why: an aborted run must not be judged against time it never ran.
 */
function measuredSeconds(phasePlan, times) {
  const planned = measuredPhaseOf(phasePlan)?.durationSeconds ?? null;
  if (times?.sendEndedEarly && times.measureStart && times.sendEnd) {
    const ran = (new Date(times.sendEnd) - new Date(times.measureStart)) / 1000;
    if (ran > 0) return Math.min(ran, planned ?? ran);
  }
  return planned;
}

/**
 * collector.throughput: accepted events per second in the measured phase ≥ (1 − RATE_SHORTFALL_TOLERANCE) ×
 * target. Why: the lead's first question is "how much load went through in the interval"; this rule
 * states it against the expectation. It counts only events the collector accepted (202 "accepted").
 * Source 'k6': the number comes from k6's events_accepted counter.
 */
function throughputThreshold({ normalised, phasePlan, settings, times, targetRate, k6Limited }) {
  const scenario = phasePlan.measuredPhase;
  const onlyOnePhase = phasePlan.phases.length === 1; // smoke: the totals ARE the measured numbers
  const accepted =
    metricValue(normalised, `events_accepted{scenario:${scenario}}`, 'count') ??
    (onlyOnePhase ? metricValue(normalised, 'events_accepted', 'count') : null);
  const seconds = measuredSeconds(phasePlan, times);
  const actual = accepted !== null && seconds ? accepted / seconds : null;
  const limit = (1 - settings.RATE_SHORTFALL_TOLERANCE) * targetRate;
  const passed = actual !== null && actual >= limit;
  return {
    id: 'collector.throughput',
    metric: `events_accepted{scenario:${scenario}}`,
    rule: `accepted per second >= ${formatNumber(limit)}`,
    limit,
    actual,
    unit: 'events/s',
    passed,
    toBeConfirmed: true,
    source: 'k6',
    // With the k6 limit, k6 could not send: a shortfall here is the load generator's, not the collector's.
    ...(k6Limited && !passed ? { informational: true } : {}),
    description:
      `Accepted events per second in the measured phase at least ${formatNumber(limit)} ` +
      `(target ${formatNumber(targetRate)}/s − ${formatPercent(settings.RATE_SHORTFALL_TOLERANCE)} tolerance)` +
      (k6Limited && !passed
        ? ' — k6 limit: the load generator could not send, not a service failure'
        : ''),
  };
}

/**
 * Server-side time of /v1/events over the run from service-metrics.json (Δsum / Δcount and the max).
 * Why: k6's p95 includes the network and k6 itself; this says how long the collector spent per request.
 * @returns {{avgMs:number, maxMs:number|null}|null}
 */
export function serverSideTime(serviceMetrics) {
  const samples = (serviceMetrics?.samples ?? []).filter(
    (s) =>
      s.service === 'collector' &&
      typeof s.metrics?.serverRequestSecondsSum === 'number' &&
      typeof s.metrics?.serverRequestCount === 'number',
  );
  if (samples.length < 2) return null;
  const first = samples[0].metrics;
  const last = samples[samples.length - 1].metrics;
  const count = last.serverRequestCount - first.serverRequestCount;
  if (!(count > 0)) return null; // no request in between, or the service restarted (counter reset)
  const maxes = samples
    .map((s) => s.metrics.serverRequestSecondsMax)
    .filter((v) => typeof v === 'number');
  return {
    avgMs: ((last.serverRequestSecondsSum - first.serverRequestSecondsSum) / count) * 1000,
    maxMs: maxes.length ? Math.max(...maxes) * 1000 : null,
  };
}

/** Default reader of <resultsDir>/service-metrics.json; why: evaluate gets no service metrics in `partial`. */
function readServiceMetricsFromResults(ctx) {
  return ctx.resultsDir
    ? readJsonIfExists(path.join(ctx.resultsDir, 'service-metrics.json'))
    : null;
}

/** Plain-language staircase advice for the report (refine, go higher, start lower, or k6 limit). */
function staircaseNote({ levels, ctx, phasePlan, normalised }) {
  const env = ctx.environment?.name ?? '<env>';
  const dir = ctx.context?.resultsDir ?? 'results/collector-breakpoint-<stamp>';
  const top = measuredPhaseOf(phasePlan)?.levels?.at(-1)?.rate ?? null;
  if (levels.k6Limited) {
    const p95 = measuredP95(normalised, phasePlan);
    return (
      `k6 was the limit at ${formatNumber(levels.brokeAtRate)}/s while the collector answered in ` +
      `${formatNumber(p95)} ms (p95): the collector holds at least ${formatNumber(levels.heldUpTo ?? levels.brokeAtRate)}/s. ` +
      'Run k6 on its own host (or raise MAX_VUS) to find its real limit.'
    );
  }
  if (levels.brokeAtRate === null) {
    return `Never broke up to the top level ${formatNumber(top)}/s: add higher LEVELS (--set LEVELS=…) to find the limit.`;
  }
  if (levels.heldUpTo === null) {
    return `Broke at the first level (${formatNumber(levels.brokeAtRate)}/s): start lower, e.g. --set LEVELS=50,100,150,200.`;
  }
  return (
    `Narrow it down: scripts/run-test.sh ${env} collector breakpoint --refine-from ${dir} ` +
    `(finer levels between ${formatNumber(levels.heldUpTo)}/s and ${formatNumber(levels.brokeAtRate)}/s, ` +
    `warm-up at ${formatNumber(levels.heldUpTo)}/s).`
  );
}

/**
 * The collector's evaluation of a finished run (plan §6.4 evaluate). The result builder already adds the
 * k6 rules (thresholdsFromK6) and its own window/level analysis; this returns only what is collector-
 * specific: the throughput rule, the k6-limit / staircase facts, processed events and notes.
 * @param {object} ctx run ctx
 * @param {{k6Summary:object|null, dataChecks?:object[], times?:object, phasePlan?:object}} partial
 * @param {{readServiceMetrics?:(ctx:object)=>object|null}} [options] injected by unit tests
 * @returns {{thresholds:object[], breaking:object, load:object, notes:string[]}}
 */
export function evaluateCollector(
  ctx,
  partial,
  { readServiceMetrics = readServiceMetricsFromResults } = {},
) {
  const settings = ctx.settings;
  const phasePlan = partial.phasePlan ?? ctx.phasePlan;
  const times = partial.times ?? ctx.times ?? null;
  const dataChecks = partial.dataChecks ?? [];
  const thresholds = [];
  const breaking = {};
  const load = {};
  const notes = [];

  // "Processed" for the collector = stored as ACCEPTED (sent = accepted = stored is the data story).
  const stored = dataChecks.find((c) => c.id === 'collector.stored-equals-accepted');
  if (typeof stored?.actual === 'number') load.eventsProcessed = stored.actual;

  const backlog = dataChecks.find((c) => c.id === 'collector.downstream-backlog-left');
  if (typeof backlog?.actual === 'number' && backlog.actual > 0) {
    notes.push(
      `The matcher was still draining ${formatNumber(backlog.actual)} events after this run: the next ` +
        'collector or matcher test waits for it (IDLE_TIMEOUT).',
    );
  }

  if (!partial.k6Summary) {
    notes.push('No k6 summary: nothing to evaluate beyond the data checks.');
    return { thresholds, breaking, load, notes };
  }
  const normalised = normaliseK6Summary(partial.k6Summary);
  const measureStart = times?.measureStart ?? null;
  // Same expectation the report shows; its target rate is what the throughput rule is held against.
  const { targetRate } = collectorExpectation({ testType: phasePlan.testType, settings });

  if (phasePlan.testType === 'breakpoint') {
    // Staircase facts (plan §6.9); the verdict rule breakpoint.held-up-to is added by the result builder.
    const levels = analyseLevels({ normalised, phasePlan, settings, measureStart });
    breaking.k6Limited = levels.k6Limited;
    breaking.heldUpTo = levels.heldUpTo;
    breaking.brokeAtRate = levels.brokeAtRate;
    notes.push(staircaseNote({ levels, ctx, phasePlan, normalised }));
  } else {
    const windows = analyseWindows({ normalised, phasePlan, settings, measureStart, kind: 'http' });
    breaking.k6Limited = windows.k6Limited;
    thresholds.push(
      throughputThreshold({
        normalised,
        phasePlan,
        settings,
        times,
        targetRate,
        k6Limited: windows.k6Limited,
      }),
    );
    if (windows.k6Limited) {
      notes.push(
        'k6 limit: k6 could not start every planned request on time while the collector answered fast. ' +
          'The collector held the rate as far as it was offered; run k6 on its own host for real numbers.',
      );
    }
  }

  const server = serverSideTime(readServiceMetrics(ctx));
  if (server) {
    notes.push(
      `Collector server-side time per ${EVENTS_URI} request over the run: average ${formatNumber(server.avgMs)} ms` +
        `${server.maxMs === null ? '' : `, highest ${formatNumber(server.maxMs)} ms`} ` +
        '(the service exports no histogram buckets, so p95 comes from k6 only).',
    );
  }
  return { thresholds, breaking, load, notes };
}

/**
 * The numbers of a collector result worth tracking in a baseline (plan §8.3).
 * Why: comparing these over time shows a regression; smoke runs prove the path works and have none.
 * @param {object} result result.json
 * @returns {Array<{key:string, label:string, unit:string, better:'lower'|'higher', value:number|null}>}
 */
export function collectorBaselineMetrics(result) {
  const testType = result.testType;
  const prefix = `collector.${testType}`;
  if (testType === 'load' || testType === 'stress') {
    return [
      {
        key: `${prefix}.p95Ms`,
        label: `Collector ${testType} p95`,
        unit: 'ms',
        better: 'lower',
        value: result.latency?.p95 ?? null,
      },
      {
        key: `${prefix}.averageRate`,
        label: `Collector ${testType} average rate`,
        unit: 'events/s',
        better: 'higher',
        value: result.load?.averageRate ?? null,
      },
    ];
  }
  if (testType === 'breakpoint') {
    return [
      {
        key: `${prefix}.heldUpTo`,
        label: 'Collector held up to',
        unit: 'events/s',
        better: 'higher',
        value: result.breaking?.heldUpTo ?? null,
      },
      {
        key: `${prefix}.brokeAtRate`,
        label: 'Collector broke at',
        unit: 'events/s',
        better: 'higher',
        value: result.breaking?.brokeAtRate ?? null,
      },
    ];
  }
  return [];
}

export default {
  service: 'cce-collector-service',
  subject: 'collector',
  idCode: 'col', // in test-data ids: LOADTEST-<runId>-col-<phaseIndex>-<n> (plan §2.1)
  displayName: 'Collector',
  kind: 'k6', // load comes from k6 (HTTP), not from seeding
  breakpointKind: 'staircase', // HTTP services break by answering slowly or failing: climb level by level
  testTypes: TEST_TYPES,
  // Drives preflight and the run's clients. kafka: true so the run gets a Kafka admin client to read the
  // matcher lag (idle wait, backlog-left check); preflight still treats Kafka as a warning for the collector.
  // protocol: the plan-definition set decides what the matcher does with every accepted event.
  requires: { services: ['collector'], postgres: true, kafka: true, protocol: true },

  /**
   * The k6 script of a test type, relative to this file.
   * Why: module-relative, so the folder works wherever it is copied; the runner maps it to /tests/….
   * @param {string} testType
   * @returns {URL}
   */
  testFile(testType) {
    if (!TEST_TYPES.includes(testType)) {
      throw new Error(`The collector has no ${testType} test (it has: ${TEST_TYPES.join(', ')})`);
    }
    return new URL(`./tests/collector-${testType}.test.js`, import.meta.url);
  },

  expectation: collectorExpectation,

  /**
   * Waits until the matcher is idle (Kafka lag 0, processed counter flat for IDLE_FLAT_DURATION).
   * Why: every accepted collector event also goes to the matcher, and a matcher still draining the
   * previous test competes for the shared Postgres and slows the collector (lesson 10).
   * @param {object} ctx run ctx
   * @param {object} [options] extra options for waitForMatcherIdle (unit tests pass sleep/now)
   */
  async waitForIdle(ctx, options = {}) {
    ctx.logger?.info?.(
      'collector events also feed the matcher: waiting until the matcher is idle (shared Postgres) …',
    );
    return waitForMatcherIdle(ctx, {
      flatSeconds: ctx.settings.IDLE_FLAT_DURATION,
      timeoutSeconds: ctx.settings.IDLE_TIMEOUT,
      ...options,
    });
  },

  sampledMetrics: COLLECTOR_SAMPLED_METRICS,

  /** Data checks after the run (data-checks/collector-data-checks.mjs). */
  dataChecks: (ctx) => runCollectorDataChecks(ctx),

  /** Collector-specific rules, facts and notes (evaluateCollector). */
  evaluate: (ctx, partial) => evaluateCollector(ctx, partial),

  baselineMetrics: collectorBaselineMetrics,
};
