/**
 * service-module.mjs — plugs the matcher performance tests into the shared runner (plan §6.4).
 *
 * What:    Tells `node tools/cli.mjs run <env> matcher <test-type>` everything specific to the matcher:
 *          - how it is fed: k6 writes CloudEvents into Kafka (kind 'k6'); the breakpoint is a "flood"
 *            (2,000 events/s for 1 min by default) whose drain rate is the matcher's capacity;
 *          - what must be up before a run (matcher, Postgres, Kafka, protocol service → preflight);
 *          - what we expect it to withstand, in plain words (shown next to the result in every report);
 *          - that it must be idle first (Kafka lag 0 and counters flat: the counters are global);
 *          - the backlog watcher that measures it, the extra service metrics to sample, the data checks;
 *          - the module-specific rules (evaluate) and the numbers worth keeping in baselines.
 * How:     Found automatically by tools/core/service-registry.mjs; never imported by other services.
 *            node tools/cli.mjs run local matcher smoke --dry-run      (prints settings, nothing runs)
 *            scripts/run-test.sh local matcher load                    (a real run)
 * Needs:   ./shared.mjs (shared tooling), ./watchers/backlog-watcher.mjs, ./data-checks/matcher-data-checks.mjs,
 *          ./tests/matcher-<test-type>.test.js; resolved settings of plan §3.2.
 * Outputs: The service module object (default export) and its helpers (named exports, for unit tests).
 */
import { runMatcherDataChecks } from './data-checks/matcher-data-checks.mjs';
import { formatDuration, formatNumber, waitForMatcherIdle } from './shared.mjs';
import { WATCHER_NAME, createBacklogWatcher } from './watchers/backlog-watcher.mjs';

/** The four test types; the matcher "flood" is its breakpoint (plan §2.1). */
export const TEST_TYPES = Object.freeze(['smoke', 'load', 'stress', 'breakpoint']);

/**
 * CCE's own alert level for event processing time (deploy-scripts alert rules: p99 > 0.5 s).
 * The matcher exports no histogram buckets, so the slowest event (_max) stands in for p99 (informational).
 */
export const PROCESSING_ALERT_MS = 500;

/**
 * Matcher-specific metrics the shared sampler reads every WATCH_INTERVAL (plan §6.3 SampledMetric).
 * processingSecondsSum/Count are the keys PEAK_SIGNALS uses for "average processing time per event".
 */
export const SAMPLED_METRICS = Object.freeze([
  {
    key: 'matchedEvents',
    name: 'cce_events_matched_total',
    labels: { status: 'matched' },
    agg: 'sum',
    unit: 'events',
  },
  {
    key: 'zeroMatchEvents',
    name: 'cce_events_matched_total',
    labels: { status: 'zero_match' },
    agg: 'sum',
    unit: 'events',
  },
  { key: 'duplicateEvents', name: 'cce_events_duplicate_total', agg: 'sum', unit: 'events' },
  { key: 'inboundErrors', name: 'cce_consumer_inbound_errors_total', agg: 'sum', unit: 'errors' },
  {
    key: 'processingSecondsSum',
    name: 'cce_events_processing_duration_seconds_sum',
    agg: 'sum',
    unit: 'seconds',
  },
  {
    key: 'processingSecondsCount',
    name: 'cce_events_processing_duration_seconds_count',
    agg: 'sum',
    unit: 'events',
  },
  {
    key: 'processingSecondsMax',
    name: 'cce_events_processing_duration_seconds_max',
    agg: 'max',
    unit: 'seconds',
  },
]);

/** "set overlapping-4 (4 plan definitions)"; why: the set drives the matcher's cost (fan-out). */
function describeSet(planDefinitionSet) {
  if (!planDefinitionSet?.name) return 'the configured plan-definition set';
  const fanOut = planDefinitionSet.effectiveFanOut ?? planDefinitionSet.fanOut;
  return typeof fanOut === 'number'
    ? `set ${planDefinitionSet.name} (${fanOut} plan definition${fanOut === 1 ? '' : 's'} per event)`
    : `set ${planDefinitionSet.name}`;
}

/**
 * What the matcher is expected to withstand in this test, in plain words (R1.3).
 * Why: every report prints it next to the result; limits come from the settings (none hard-coded).
 * @param {{testType:string, settings:Record<string, any>, planDefinitionSet?:object}} input
 * @returns {{summary:string, targetRate:number, peakRate:number, multipleOfPeak:number, unit:string, toBeConfirmed:boolean}}
 */
export function buildExpectation({ testType, settings, planDefinitionSet }) {
  const peak = settings.PEAK_RATE;
  const rules =
    `backlog never above ${formatNumber(settings.MATCHER_MAX_BACKLOG)} events, caught up within ` +
    `${formatDuration(settings.MATCHER_MAX_CATCH_UP)} after sending stops, ` +
    `${formatNumber(settings.MATCHER_MAX_KAFKA_WRITE_ERRORS)} Kafka write errors, ` +
    `at most ${formatNumber(settings.MATCHER_MAX_DEAD_LETTERS)} dead letters`;
  const times = (rate) => formatNumber(rate / peak, 2);
  const set = describeSet(planDefinitionSet);
  if (testType === 'breakpoint') {
    const target = settings.EXPECTED_HEADROOM * peak;
    const events = settings.MATCHER_FLOOD_RATE * settings.MATCHER_FLOOD_DURATION;
    return {
      summary:
        `Drain a flood of ${formatNumber(events)} events (${formatNumber(settings.MATCHER_FLOOD_RATE)}/s for ` +
        `${formatDuration(settings.MATCHER_FLOOD_DURATION)}) at ≥ ${formatNumber(target)} events/s ` +
        `(${times(target)} × peak ${formatNumber(peak)}/s) with ${set}.`,
      targetRate: target,
      peakRate: peak,
      multipleOfPeak: target / peak,
      unit: 'events',
      toBeConfirmed: true,
    };
  }
  const prefix = { smoke: 'SMOKE', load: 'LOAD', stress: 'STRESS' }[testType];
  if (!prefix) throw new Error(`The matcher has no ${testType} test`);
  const rate = settings[`${prefix}_RATE`];
  const duration = settings[`${prefix}_DURATION`];
  const opening =
    testType === 'smoke'
      ? `Smoke: ${formatNumber(rate)} event/s for ${formatDuration(duration)} is logged, matched and enrolled`
      : `Withstand ${formatNumber(rate)} events/s (${times(rate)} × peak ${formatNumber(peak)}/s) for ${formatDuration(duration)}`;
  return {
    summary: `${opening} with ${set}: ${rules}.`,
    targetRate: rate,
    peakRate: peak,
    multipleOfPeak: rate / peak,
    unit: 'events',
    toBeConfirmed: true,
  };
}

/**
 * Module-specific verdict pieces (plan §6.4 evaluate). The result builder already has the k6 rules
 * (thresholdsFromK6) and the watcher rules; this returns the watcher rules unchanged (same ids, so no
 * duplicates) plus rules only this module knows, and notes that explain the numbers.
 * @param {object} ctx run ctx
 * @param {{k6Summary?:object|null, watcherOutcomes?:object[], dataChecks?:object[], times?:object}} partial
 * @returns {{thresholds:object[], breaking:object, load:object, notes:string[]}}
 */
export function evaluateMatcherRun(ctx, partial = {}) {
  const outcome = (partial.watcherOutcomes ?? []).find((o) => o.name === WATCHER_NAME) ?? null;
  const thresholds = [];
  const notes = [];
  if (!outcome || outcome.error) {
    // Without the watcher there is no backlog, catch-up or drain rate: the run cannot pass.
    thresholds.push({
      id: 'matcher.backlog-watcher',
      metric: 'backlogWatcher',
      rule: 'watcher ran',
      limit: null,
      actual: null,
      unit: '',
      passed: false,
      toBeConfirmed: false,
      source: 'watcher',
      description: `The backlog watcher measured the matcher (${outcome?.error ?? 'no watcher outcome'})`,
    });
  } else {
    thresholds.push(...(outcome.thresholds ?? []));
    const maxMs = outcome.summary?.processingMaxMs ?? null;
    thresholds.push({
      id: 'matcher.processing-time',
      metric: 'processingMaxMs',
      rule: `max < ${PROCESSING_ALERT_MS}`,
      limit: PROCESSING_ALERT_MS,
      actual: maxMs,
      unit: 'ms',
      passed: typeof maxMs === 'number' && maxMs < PROCESSING_ALERT_MS,
      toBeConfirmed: true,
      source: 'watcher',
      // Shown, never decides: without histogram buckets the p99 of CCE's alert rule cannot be computed.
      informational: true,
      description: `Slowest event processed within ${PROCESSING_ALERT_MS} ms (stand-in for CCE's p99 alert; no histogram buckets)`,
    });
    const avg = outcome.summary?.processingMsAvg;
    if (typeof avg === 'number') {
      notes.push(
        `Average matcher processing time ${formatNumber(avg, 1)} ms per event (Δsum / Δcount of cce_events_processing_duration_seconds).`,
      );
    }
    if (outcome.summary?.sendEndedEarly) {
      notes.push(
        'k6 stopped sending before the planned end; catch-up is measured from when it stopped.',
      );
    }
    for (const warning of outcome.warnings ?? []) notes.push(`Backlog watcher: ${warning}`);
  }
  // Kafka "accepted" only means "handed to the producer" (xk6-kafka does not wait for the broker).
  notes.push(
    'Kafka writes count as accepted when handed to the producer; delivery is proven by the backlog watcher and the data checks.',
  );
  if (ctx?.phasePlan?.testType === 'breakpoint') {
    notes.push(
      'Flood: dropped iterations mean k6 could not send the whole flood on time; the drain rate is still valid (Kafka tests never report a k6 limit).',
    );
  }
  return { thresholds, breaking: {}, load: {}, notes };
}

/** Mean of numbers (null when none); why: average processed rate over the measured windows. */
function mean(values) {
  const numbers = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null;
}

/**
 * Numbers of one matcher result worth tracking over time (plan §8.3), read from result.json only.
 * Why: the baseline tool compares them across runs; a run that did not catch up never gets a
 * catch-up number (the baseline then says "not caught up").
 * @param {object} result result.json
 * @returns {Array<{key:string, label:string, unit:string, better:'lower'|'higher', value:number|null}>}
 */
export function matcherBaselineMetrics(result) {
  const type = result.testType;
  const prefix = `matcher.${type}`;
  const breaking = result.breaking ?? {};
  const backlogRule = (result.thresholds ?? []).find((t) => t.id === 'matcher.backlog');
  const backlogs = (result.timeSeries?.points ?? []).map((p) => p.backlog);
  const maxBacklog =
    typeof backlogRule?.actual === 'number'
      ? backlogRule.actual
      : backlogs.some((b) => typeof b === 'number')
        ? Math.max(...backlogs.filter((b) => typeof b === 'number'))
        : null;
  const processingMsAvg = result.serviceMetrics?.peaks?.matcher?.processingMsAvg?.value ?? null;
  const metric = (name, label, unit, better, value) => ({
    key: `${prefix}.${name}`,
    label: `Matcher ${type} ${label}`,
    unit,
    better,
    value: typeof value === 'number' ? value : null,
  });
  if (type === 'load') {
    return [
      metric('maxBacklog', 'max backlog', 'events', 'lower', maxBacklog),
      metric(
        'catchUpSeconds',
        'catch-up',
        's',
        'lower',
        breaking.caughtUp === true ? breaking.catchUpSeconds : null,
      ),
      metric('processingMsAvg', 'processing time per event', 'ms', 'lower', processingMsAvg),
    ];
  }
  if (type === 'stress') {
    const measured = result.load?.measuredSeconds ?? Infinity;
    const processedPerSecond = mean(
      (result.timeSeries?.points ?? [])
        .filter((p) => typeof p.t === 'number' && p.t >= 0 && p.t < measured)
        .map((p) => p.processedPerSecond),
    );
    return [
      metric(
        'processedPerSecond',
        'processed per second',
        'events/s',
        'higher',
        processedPerSecond,
      ),
      metric('maxBacklog', 'max backlog', 'events', 'lower', maxBacklog),
      metric(
        'secondsToBreak',
        'seconds until it started breaking',
        's',
        'higher',
        breaking.secondsIntoMeasure,
      ),
      metric('processingMsAvg', 'processing time per event', 'ms', 'lower', processingMsAvg),
    ];
  }
  if (type === 'breakpoint') {
    return [metric('drainRate', 'drain rate', 'events/s', 'higher', breaking.drainRate)];
  }
  return []; // smoke proves the setup; it is not a baseline figure
}

export default {
  service: 'cce-matcher-service',
  subject: 'matcher',
  idCode: 'mat',
  displayName: 'Matcher',
  kind: 'k6',
  breakpointKind: 'flood',
  testTypes: [...TEST_TYPES],
  // Drives preflight (plan §7.1): matcher health/metrics, Postgres, Kafka topic + consumer group, the set via the protocol service.
  requires: { services: ['matcher'], postgres: true, kafka: true, protocol: true },

  /** The k6 script of a test type, relative to THIS file so the folder works wherever it is copied. */
  testFile(testType) {
    return new URL(`./tests/matcher-${testType}.test.js`, import.meta.url);
  },

  expectation: (input) => buildExpectation(input),

  /**
   * Counters are global: start only when lag is 0 and the processed counter is flat for IDLE_FLAT_DURATION
   * (gives up after IDLE_TIMEOUT, exit 2). The shared helper itself (tools/core/idle.mjs), so the collector
   * module and this one wait the same way; its optional 2nd argument injects a fake clock in unit tests.
   */
  waitForIdle: waitForMatcherIdle,

  watchers: [(ctx) => createBacklogWatcher(ctx)],

  sampledMetrics: SAMPLED_METRICS,

  dataChecks: (ctx) => runMatcherDataChecks(ctx),

  evaluate: (ctx, partial) => evaluateMatcherRun(ctx, partial),

  baselineMetrics: (result) => matcherBaselineMetrics(result),
};
