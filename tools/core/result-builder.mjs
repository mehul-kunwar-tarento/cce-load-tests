/**
 * result-builder.mjs — assembles result.json (schema 1.0.0, plan §5.2) and decides the verdict.
 *
 * What:    After a run, everything that was measured is spread over several files: the k6 summary,
 *          watcher samples, service metrics, data checks, the conditions. This module combines them into
 *          ONE result.json, the only input of reports and baselines. Rules: every field of §5.2 is present
 *          (null when it does not apply, never omitted); numbers are raw; times are ISO-8601 with offset
 *          and re-based on the authoritative k6 start from k6-summary.json (or on the seed times of a
 *          seeded Step SLA run); thresholds = k6 rules ∪ watcher rules ∪ module rules, de-duplicated by id.
 *          load.eventsThrough / throughBasis / throughSeconds / averageRate say what the SERVICE took
 *          (accepted, processed or handled; events-through.mjs), not what k6 sent.
 *          Status: passed (every required rule and data check passed) · failed · aborted (abort rule,
 *          stall, Ctrl-C; partial data kept) · error (the tool could not run the test; no verdict).
 * How:     import { buildResult } from './result-builder.mjs'; const result = buildResult({ … });
 * Needs:   Outputs of k6-summary.mjs, breaking-analysis.mjs, sampled-metrics.mjs, the service module.
 * Outputs: A Result object (validate with result-schema.mjs validateResult, then write result.json).
 */
import { analyseLevels, analyseWindows, diagnosticsNear } from './breaking-analysis.mjs';
import { decideThrough } from './events-through.mjs';
import { formatNumber, toIsoWithOffset } from './format.mjs';
import { k6Timing, metricValue, normaliseK6Summary, thresholdsFromK6 } from './k6-summary.mjs';
import { allowedDropped, measuredPhaseOf } from './lib-bridge.mjs';
import { computePeaks } from './sampled-metrics.mjs';
import { settingsForResult } from './settings.mjs';

/** result.json schema version written by this builder. */
export const RESULT_SCHEMA_VERSION = '1.0.0';

/** ms since epoch of an ISO time, or null. */
function ms(iso) {
  if (iso === null || iso === undefined) return null;
  const value = new Date(iso).getTime();
  return Number.isFinite(value) ? value : null;
}

/** ISO with local offset of a ms value, or null; why: every time in result.json has an offset (§5.2). */
function iso(value) {
  return value === null || value === undefined ? null : toIsoWithOffset(value);
}

/**
 * Decides the timing block (plan §5.2 "timing", §6.2 steps 6, 8, 9).
 * Why: one authoritative "measured phase started at / sending ended at", whatever produced it.
 * @returns {{source:string, k6StartedAt:string|null, measureStart:string|null, sendEnd:string|null, sendEndedEarly:boolean}}
 */
export function decideTiming({ normalised, phasePlan, times, prepareResult, k6ExitedAt }) {
  if (prepareResult) {
    return {
      source: 'seed',
      k6StartedAt: null,
      measureStart: iso(ms(prepareResult.measureStart)),
      sendEnd: iso(ms(prepareResult.sendEnd)),
      sendEndedEarly: false,
    };
  }
  const measured = phasePlan ? measuredPhaseOf(phasePlan) : null;
  const summaryStart = ms(k6Timing(normalised).k6StartedAt);
  let source = null;
  let startMs = null;
  if (summaryStart !== null) {
    source = 'k6-setup';
    startMs = summaryStart;
  } else if (times?.k6StartedAt) {
    source = times.source ?? 'estimated';
    startMs = ms(times.k6StartedAt);
  }
  if (startMs === null || !measured) {
    return {
      source: source ?? 'estimated',
      k6StartedAt: iso(startMs),
      measureStart: times?.measureStart ?? null,
      sendEnd: times?.sendEnd ?? null,
      sendEndedEarly: Boolean(times?.sendEndedEarly),
    };
  }
  const measureStartMs = startMs + measured.startSeconds * 1000;
  let sendEndMs = measureStartMs + measured.durationSeconds * 1000;
  let sendEndedEarly = false;
  // k6 stopped before the planned end (abort rule, Ctrl-C, error): sending ended when k6 exited.
  const exitedMs = ms(k6ExitedAt);
  if (exitedMs !== null && exitedMs < sendEndMs) {
    sendEndMs = Math.max(exitedMs, measureStartMs);
    sendEndedEarly = true;
  }
  return {
    source,
    k6StartedAt: iso(startMs),
    measureStart: iso(measureStartMs),
    sendEnd: iso(sendEndMs),
    sendEndedEarly,
  };
}

/** Phases with clock times (plan §5.2 "phases"), plus a catch-up phase when watchers waited. */
function buildPhases({ phasePlan, timing, k6ExitedAt, watchersEndedAt, prepareResult }) {
  const phases = [];
  const startMs = ms(timing.k6StartedAt);
  const exitedMs = ms(k6ExitedAt);
  if (prepareResult) {
    const measured = measuredPhaseOf(phasePlan);
    phases.push({
      name: measured?.name ?? 'measure',
      startedAt: timing.measureStart,
      endedAt: timing.sendEnd,
      rate: measured?.rate ?? null,
      plannedEvents: prepareResult.plannedEvents ?? measured?.plannedEvents ?? null,
    });
  } else if (phasePlan) {
    for (const phase of phasePlan.phases) {
      const begin = startMs === null ? null : startMs + phase.startSeconds * 1000;
      let end = begin === null ? null : begin + phase.durationSeconds * 1000;
      if (end !== null && exitedMs !== null) end = Math.min(end, exitedMs);
      // A phase k6 never reached keeps its planned times but is marked by an end before its start.
      phases.push({
        name: phase.name,
        startedAt: iso(begin),
        endedAt: iso(end),
        rate: phase.rate,
        plannedEvents: phase.plannedEvents,
      });
    }
  }
  if (watchersEndedAt && timing.sendEnd) {
    phases.push({
      name: 'catch-up',
      startedAt: timing.sendEnd,
      endedAt: iso(ms(watchersEndedAt)),
      rate: null,
      plannedEvents: null,
    });
  }
  return phases;
}

/** Copies the defined fields of `patch` over `base`; why: watcher/module values override defaults. */
function overlay(base, patch) {
  for (const [key, value] of Object.entries(patch ?? {}))
    if (value !== undefined) base[key] = value;
  return base;
}

/** The load block (plan §5.2 "load", §4.7 counters). */
function buildLoad({ normalised, phasePlan, settings, timing, expectation, prepareResult, unit }) {
  const measuredName = phasePlan?.measuredPhase ?? 'measure';
  const plannedEvents = prepareResult?.plannedEvents ?? phasePlan?.plannedEvents ?? null;
  const has = Boolean(normalised);
  const total = (name) => metricValue(normalised, name, 'count');
  const measured = (name) => metricValue(normalised, `${name}{scenario:${measuredName}}`, 'count');
  const onlyMeasured = phasePlan?.phases?.length === 1;
  const eventsSent = has ? (total('events_sent') ?? total('iterations')) : null;
  const eventsAccepted = has ? total('events_accepted') : null;
  // Without warm-up the totals ARE the measured numbers.
  const measuredEventsSent = has
    ? (measured('events_sent') ?? measured('iterations') ?? (onlyMeasured ? eventsSent : null))
    : null;
  const measuredEventsAccepted = has
    ? (measured('events_accepted') ?? (onlyMeasured ? eventsAccepted : null))
    : null;
  // k6 only reports dropped_iterations when something was dropped: absent in a summary means 0.
  const eventsDropped = has ? (total('dropped_iterations') ?? 0) : null;
  const measuredSeconds =
    ms(timing.sendEnd) !== null && ms(timing.measureStart) !== null
      ? Math.max(0, (ms(timing.sendEnd) - ms(timing.measureStart)) / 1000)
      : null;
  return {
    unit,
    plannedEvents,
    eventsSent,
    eventsAccepted,
    eventsFailed:
      eventsSent !== null && eventsAccepted !== null ? eventsSent - eventsAccepted : null,
    eventsDropped,
    droppedRate: eventsDropped !== null && plannedEvents ? eventsDropped / plannedEvents : null,
    droppedAllowed:
      has && plannedEvents !== null
        ? allowedDropped(plannedEvents, settings.MAX_DROPPED_RATE)
        : null,
    eventsProcessed: null,
    measuredEventsSent,
    measuredEventsAccepted,
    measuredSeconds,
    // Decided after watchers and the module have spoken (events-through.mjs): what the SERVICE took
    // ÷ the time it had, never what k6 sent.
    averageRate: null,
    targetRate: expectation?.targetRate ?? null,
  };
}

/** Latency of the measured scenario from k6 (HTTP only), or null (plan §5.2 "latency"). */
function buildLatency(normalised, phasePlan) {
  if (!normalised) return null;
  const scenario = phasePlan?.measuredPhase ?? 'measure';
  const key = normalised.metrics[`http_req_duration{scenario:${scenario}}`]
    ? `http_req_duration{scenario:${scenario}}`
    : 'http_req_duration';
  const values = normalised.metrics[key]?.values;
  if (!values) return null;
  const pick = (stat) => (typeof values[stat] === 'number' ? values[stat] : null);
  return {
    unit: 'ms',
    source: `k6 ${key}`,
    avg: pick('avg'),
    med: pick('med'),
    p90: pick('p(90)'),
    p95: pick('p(95)'),
    p99: pick('p(99)'),
    max: pick('max'),
  };
}

/**
 * True for a k6 rule of a staircase that only finds the breaking point: the per-level rules
 * ({level:R}) and the run's BREAKPOINT_MAX_DROPPED abort rule (plan §4.2).
 * Why: a staircase is meant to climb until a level breaks; that is its normal end, not a failure.
 */
export function isStaircaseSearchRule(threshold, values) {
  if (threshold.source !== 'k6') return false;
  if (/\{(.*,)?level:/.test(threshold.metric)) return true;
  return (
    threshold.metric === 'dropped_iterations' && threshold.limit === values.BREAKPOINT_MAX_DROPPED
  );
}

/**
 * The verdict rule of a staircase: it held at least the expected rate (expectation.targetRate,
 * e.g. EXPECTED_HEADROOM × PEAK_RATE). Id 'breakpoint.held-up-to'; a service module may return a rule
 * with the same id to replace it. With the k6 limit, "held" means "at least" (the service was not the limit).
 */
function capacityThresholds({ staircase, expectation, values }) {
  const target = expectation?.targetRate;
  if (typeof target !== 'number') return [];
  const held = staircase.heldUpTo;
  const peak = expectation?.peakRate ?? values.PEAK_RATE;
  const multiple =
    typeof peak === 'number' && peak > 0 ? ` (${formatNumber(target / peak, 1)} × peak)` : '';
  return [
    {
      id: 'breakpoint.held-up-to',
      metric: 'heldUpTo',
      rule: `held up to >= ${target}`,
      limit: target,
      actual: held,
      unit: 'events/s',
      passed: typeof held === 'number' && held >= target,
      toBeConfirmed: true,
      source: 'k6',
      description: `Staircase held at least ${formatNumber(target)}/s${multiple}${staircase.k6Limited ? ' (k6 limit: "held" means at least)' : ''}`,
    },
  ];
}

/** De-duplicates thresholds by id, later sources winning (k6 < watcher < module). */
function mergeThresholds(...lists) {
  const byId = new Map();
  for (const list of lists) for (const threshold of list ?? []) byId.set(threshold.id, threshold);
  return [...byId.values()];
}

/**
 * Status and one-line reason from the assembled parts (plan §5.2 rules).
 * Why: exported so `check-data` can re-decide the status after re-running data checks.
 * @param {{thresholds:object[], dataChecks:object[], breaking:object, aborted?:string|boolean|null, error?:string|null}} input
 * @returns {{status:'passed'|'failed'|'aborted'|'error', statusReason:string}}
 */
export function computeStatus({ thresholds, dataChecks, breaking, aborted = null, error = null }) {
  if (error) return { status: 'error', statusReason: `The test could not run: ${error}` };
  const failedRules = (thresholds ?? []).filter((t) => t.passed === false && !t.informational);
  const failedChecks = (dataChecks ?? []).filter(
    (c) => c.passed === false && c.severity !== 'info',
  );
  if (aborted) {
    const why = typeof aborted === 'string' ? aborted : 'stopped early';
    return { status: 'aborted', statusReason: `Aborted: ${why} (partial results kept)` };
  }
  if (failedRules.length || failedChecks.length) {
    if (breaking?.k6Limited && !failedChecks.length) {
      const first = (breaking.whatBroke ?? []).find((w) => w.metric === 'k6-limit');
      return {
        status: 'failed',
        statusReason: `${first?.description ?? 'k6 could not send on time (k6 limit)'}: a load-generator limit, not a service failure`,
      };
    }
    const words = [
      ...failedRules.map((t) => t.description ?? t.id),
      ...failedChecks.map(
        (c) =>
          `data check ${c.id}: expected ${formatNumber(c.expected)}, got ${formatNumber(c.actual)}`,
      ),
    ];
    const more = words.length > 3 ? ` (+${words.length - 3} more)` : '';
    return { status: 'failed', statusReason: `Failed: ${words.slice(0, 3).join('; ')}${more}` };
  }
  // A staircase that passed still broke somewhere (that is its purpose): say where.
  if (typeof breaking?.heldUpTo === 'number' || typeof breaking?.brokeAtRate === 'number') {
    const held = breaking.heldUpTo === null ? 'no level' : `${formatNumber(breaking.heldUpTo)}/s`;
    const broke =
      breaking.brokeAtRate === null
        ? 'never broke'
        : `broke at ${formatNumber(breaking.brokeAtRate)}/s`;
    const prefix = breaking.k6Limited ? 'At least' : 'Held up to';
    return {
      status: 'passed',
      statusReason: `${prefix} ${held}, ${broke}; every rule and every required data check passed`,
    };
  }
  return { status: 'passed', statusReason: 'Every rule and every required data check passed' };
}

/** Puts watcher samples into the report windows (plan §5.4: merged by t). */
function mergeWatcherSamples(points, outcomes, timing, windowSeconds) {
  const startMs = ms(timing.measureStart);
  if (startMs === null || !windowSeconds) return points;
  const byT = new Map(points.map((p) => [p.t, p]));
  for (const outcome of outcomes ?? []) {
    for (const sample of outcome.samples ?? []) {
      const atMs = ms(sample.at);
      if (atMs === null || atMs < startMs) continue;
      const t = Math.floor((atMs - startMs) / 1000 / windowSeconds) * windowSeconds;
      let point = byT.get(t);
      if (!point) {
        point = {
          t,
          at: iso(startMs + t * 1000),
          phase: 'catch-up',
          level: null,
          sent: null,
          sentPerSecond: null,
          p95Ms: null,
          failedRate: null,
          backlog: null,
          processedPerSecond: null,
          broken: false,
        };
        byT.set(t, point);
      }
      const backlog = sample.backlog ?? sample.due ?? null;
      if (typeof backlog === 'number') point.backlog = Math.max(point.backlog ?? 0, backlog);
      if (typeof sample.processedPerSecond === 'number')
        point.processedPerSecond = sample.processedPerSecond;
    }
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/**
 * Builds result.json.
 * @param {object} input
 * @param {object} input.context run context (plan §3.5)
 * @param {object} input.settings ResolvedSettings (values + sources)
 * @param {object} input.phasePlan
 * @param {object|null} [input.preflight] PreflightResult (plan §5.5) or null
 * @param {boolean} [input.preflightSkipped]
 * @param {object} [input.conditions] from captureConditions
 * @param {object|null} [input.k6Summary] raw k6-summary.json
 * @param {object[]} [input.watcherOutcomes]
 * @param {object|null} [input.serviceMetrics] parsed service-metrics.json
 * @param {object[]} [input.dataChecks]
 * @param {object} [input.moduleEvaluation] { thresholds, breaking, load, notes }
 * @param {object} [input.timings] { times, k6ExitedAt, endedAt, watchersEndedAt, prepareResult }
 * @param {number|null} [input.k6ExitCode]
 * @param {string|boolean|null} [input.aborted] reason when stopped early (Ctrl-C, stall, abort)
 * @param {string|null} [input.error] the tool could not run the test
 * @param {object} [input.expectation] module.expectation(...)
 * @param {object} [input.module] { kind, breakpointKind }
 * @param {object|null} [input.refinedFrom]
 * @param {string[]} [input.warnings]
 * @param {object} [input.definitions] defaults.json (tests)
 * @returns {object} Result
 */
export function buildResult({
  context,
  settings,
  phasePlan,
  preflight = null,
  preflightSkipped = false,
  conditions = {},
  k6Summary = null,
  watcherOutcomes = [],
  serviceMetrics = null,
  dataChecks = [],
  moduleEvaluation = {},
  timings = {},
  k6ExitCode = null,
  aborted = null,
  error = null,
  expectation = {},
  module = {},
  refinedFrom = null,
  warnings = [],
  definitions,
}) {
  const values = settings.values;
  const normalised = k6Summary ? normaliseK6Summary(k6Summary) : null;
  const {
    times = null,
    k6ExitedAt = null,
    endedAt = null,
    watchersEndedAt = null,
    prepareResult = null,
  } = timings;
  const timing = decideTiming({ normalised, phasePlan, times, prepareResult, k6ExitedAt });
  const unit = expectation?.unit ?? (module.kind === 'seeded' ? 'alarms' : 'events');

  // Load: k6 counters, then watcher and module figures (e.g. eventsProcessed) on top.
  const load = buildLoad({
    normalised,
    phasePlan,
    settings: values,
    timing,
    expectation,
    prepareResult,
    unit,
  });
  for (const outcome of watcherOutcomes) overlay(load, outcome.load);
  overlay(load, moduleEvaluation.load);

  const kind =
    normalised?.metrics?.http_reqs || normalised?.metrics?.http_req_duration ? 'http' : 'kafka';
  const isStaircase =
    phasePlan?.testType === 'breakpoint' && phasePlan?.breakpointKind === 'staircase';
  const windows =
    normalised && phasePlan
      ? analyseWindows({
          normalised,
          phasePlan,
          settings: values,
          measureStart: timing.measureStart,
          kind,
        })
      : null;
  const staircase =
    normalised && isStaircase
      ? analyseLevels({
          normalised,
          phasePlan,
          settings: values,
          measureStart: timing.measureStart,
        })
      : null;

  const k6Thresholds = normalised
    ? thresholdsFromK6(normalised, values, kind, definitions ? { definitions } : undefined)
    : [];
  // A staircase ends when a level breaks: its per-level rules FIND the breaking point, they are not the
  // verdict. The verdict of a staircase is its capacity: held up to >= the expected rate (deviation 12).
  if (staircase) {
    for (const threshold of k6Thresholds) {
      if (!isStaircaseSearchRule(threshold, values)) continue;
      threshold.informational = true;
      threshold.description = `${threshold.description} — finds the breaking point (not a verdict)`;
    }
  }
  const thresholds = mergeThresholds(
    k6Thresholds,
    staircase ? capacityThresholds({ staircase, expectation, values }) : [],
    ...watcherOutcomes.map((o) => o.thresholds),
    moduleEvaluation.thresholds,
  );

  // Breaking analysis: staircase levels or windows (k6), then watcher and module findings.
  const primary = staircase ?? windows;

  const breaking = {
    broke: false,
    startedBreakingAt: primary?.startedBreakingAt ?? null,
    secondsIntoMeasure: primary?.secondsIntoMeasure ?? null,
    rateAtBreak: staircase ? staircase.brokeAtRate : (windows?.rateAtBreak ?? null),
    whatBroke: [...(primary?.whatBroke ?? [])],
    heldUpTo: staircase?.heldUpTo ?? null,
    brokeAtRate: staircase?.brokeAtRate ?? null,
    k6Limited: Boolean(primary?.k6Limited),
    caughtUp: null,
    catchUpSeconds: null,
    remainingBacklog: null,
    gaveUpAfterSeconds: null,
    drainRate: null,
  };
  // Watchers and the module may know an earlier break (e.g. backlog) and the catch-up facts.
  for (const patch of [...watcherOutcomes.map((o) => o.breaking), moduleEvaluation.breaking]) {
    if (!patch) continue;
    const { whatBroke = [], startedBreakingAt, secondsIntoMeasure, ...rest } = patch;
    breaking.whatBroke.push(...whatBroke);
    const earlier =
      ms(startedBreakingAt) !== null &&
      (breaking.startedBreakingAt === null ||
        ms(startedBreakingAt) < ms(breaking.startedBreakingAt));
    if (earlier) {
      breaking.startedBreakingAt = iso(ms(startedBreakingAt));
      breaking.secondsIntoMeasure =
        secondsIntoMeasure ??
        (ms(timing.measureStart) !== null
          ? (ms(startedBreakingAt) - ms(timing.measureStart)) / 1000
          : null);
      breaking.rateAtBreak =
        rest.rateAtBreak ?? measuredPhaseOf(phasePlan)?.rate ?? breaking.rateAtBreak;
    }
    overlay(breaking, rest);
  }
  // Failed rules without a window/level explanation are listed as they are (e.g. watcher rules).
  const described = new Set(breaking.whatBroke.map((w) => w.metric));
  for (const threshold of thresholds) {
    if (threshold.passed !== false || threshold.informational) continue;
    if (
      threshold.source === 'k6' &&
      (breaking.k6Limited || described.has(threshold.metric.split('{')[0]))
    )
      continue;
    breaking.whatBroke.push({
      metric: threshold.metric,
      description: `${threshold.description} (actual ${formatNumber(threshold.actual)})`,
      actual: threshold.actual,
      limit: threshold.limit,
      source: threshold.source ?? 'k6',
    });
  }
  for (const check of dataChecks) {
    if (check.passed === false && check.severity !== 'info') {
      breaking.whatBroke.push({
        metric: check.id,
        description: `${check.description}: expected ${formatNumber(check.expected)}, got ${formatNumber(check.actual)}`,
        actual: check.actual,
        limit: check.expected,
        source: 'data-check',
      });
    }
  }

  // Service metrics peaks (+ watcher peaks such as slaCycleCapHits) and diagnostics near the break.
  let serviceMetricsBlock = null;
  const watcherPeaks = watcherOutcomes.filter((o) => o.peaks);
  if (serviceMetrics || watcherPeaks.length) {
    const peaks = serviceMetrics ? computePeaks(serviceMetrics) : {};
    for (const outcome of watcherPeaks) {
      const subject = outcome.subject ?? context.subject;
      peaks[subject] = { ...(peaks[subject] ?? {}), ...outcome.peaks };
    }
    serviceMetricsBlock = { file: serviceMetrics ? 'service-metrics.json' : null, peaks };
  }
  breaking.whatBroke.push(
    ...diagnosticsNear({
      peaks: serviceMetricsBlock?.peaks ?? null,
      startedBreakingAt: breaking.startedBreakingAt,
      windowSeconds: phasePlan?.windowSeconds ?? values.REPORT_WINDOW ?? 10,
    }),
  );
  breaking.broke =
    breaking.startedBreakingAt !== null ||
    breaking.whatBroke.some((w) => w.source !== 'service-metrics');

  // Aborted: Ctrl-C/stall/watcher abort, k6 "aborted by script" (108), or an abort rule ended sending early.
  const watcherAbort = watcherOutcomes.find((o) => o.aborted);
  // Only k6's own rules can stop k6 (the capacity rule is judged afterwards, it never aborts anything).
  const abortRuleFired =
    timing.sendEndedEarly && k6Thresholds.some((t) => t.passed === false && !t.informational);
  const abortReason =
    aborted ||
    (watcherAbort
      ? typeof watcherAbort.aborted === 'string'
        ? watcherAbort.aborted
        : `watcher ${watcherAbort.name} stopped the run`
      : null) ||
    (k6ExitCode === 108 ? 'k6 aborted by the test script' : null) ||
    (abortRuleFired
      ? `stopped by an abort rule (${breaking.whatBroke[0]?.description ?? 'threshold failed'})`
      : null);
  const missingSummary = module.kind === 'k6' && !normalised && !abortReason && !error;
  const verdict = computeStatus({
    thresholds,
    dataChecks,
    breaking,
    aborted: abortReason,
    error:
      error ??
      (missingSummary
        ? `k6 produced no k6-summary.json (exit code ${k6ExitCode ?? 'unknown'})`
        : null),
  });

  // "Went through" (R1): accepted (HTTP), processed (Kafka) or handled (seeded), and the average rate
  // from that number. A watcher or module that knows better may supply eventsThrough itself.
  if (!('eventsThrough' in load)) {
    const transport =
      module.kind === 'seeded' || prepareResult ? 'seeded' : normalised ? kind : null;
    const catchUpFallbackSeconds =
      ms(watchersEndedAt) !== null && ms(timing.sendEnd) !== null
        ? (ms(watchersEndedAt) - ms(timing.sendEnd)) / 1000
        : null;
    Object.assign(load, decideThrough({ load, breaking, transport, catchUpFallbackSeconds }));
  } else {
    load.throughBasis = load.throughBasis ?? null;
    load.throughSeconds = load.throughSeconds ?? null;
  }

  const timeSeries = {
    windowSeconds: phasePlan?.windowSeconds ?? null,
    points: mergeWatcherSamples(
      windows?.points ?? [],
      watcherOutcomes,
      timing,
      phasePlan?.windowSeconds,
    ),
  };
  const startedAt = context.startedAt;
  const endedAtIso = iso(ms(endedAt) ?? Date.now());
  const datasetSettings = values;

  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    kind: 'cce-performance-result',
    runId: context.runId,
    service: context.service,
    subject: context.subject,
    testType: context.testType,
    status: verdict.status,
    statusReason: verdict.statusReason,
    startedAt,
    endedAt: endedAtIso,
    durationSeconds:
      ms(startedAt) !== null ? Math.round((ms(endedAtIso) - ms(startedAt)) / 100) / 10 : null,
    timing,
    phases: buildPhases({ phasePlan, timing, k6ExitedAt, watchersEndedAt, prepareResult }),
    expectation: {
      summary: expectation?.summary ?? null,
      targetRate: expectation?.targetRate ?? null,
      peakRate: expectation?.peakRate ?? values.PEAK_RATE ?? null,
      multipleOfPeak: expectation?.multipleOfPeak ?? null,
      unit,
      toBeConfirmed: Boolean(expectation?.toBeConfirmed),
    },
    load,
    latency: buildLatency(normalised, phasePlan),
    thresholds,
    breaking,
    levels: staircase ? staircase.levels : null,
    timeSeries,
    serviceMetrics: serviceMetricsBlock,
    dataChecks,
    conditions: {
      // Every §5.2 condition is present, null when it was not captured (e.g. a dry or failed capture).
      environment: null,
      host: null,
      suite: null,
      planDefinitionSet: null,
      dataVolume: null,
      ...conditions,
      dataset: context.dataset
        ? {
            name: context.dataset.name ?? datasetSettings.DATASET,
            source: datasetSettings.EVENT_SOURCE ?? context.dataset.source ?? null,
            facilityId: datasetSettings.FACILITY_ID ?? context.dataset.facilityId ?? null,
            actionId: datasetSettings.EVENT_ACTION_ID ?? context.dataset.defaultActionId ?? null,
          }
        : null,
      settings: settingsForResult(settings),
      preflight:
        preflight || preflightSkipped
          ? {
              status: preflight?.status ?? null,
              skipped: Boolean(preflightSkipped),
              warnings: (preflight?.checks ?? [])
                .filter((c) => c.status === 'warn')
                .map((c) => `${c.id}: ${c.detail ?? c.title}`),
            }
          : null,
      note: values.NOTE ?? '',
    },
    baselineComparison: null,
    refinedFrom,
    artifacts: {
      runContext: 'run-context.json',
      k6Summary: normalised ? 'k6-summary.json' : null,
      k6Log: module.kind === 'k6' ? 'k6.log' : null,
      preflight: preflight ? 'preflight.json' : null,
      watchers: watcherOutcomes
        .map((o) => (o.file ? String(o.file).split('/').pop() : null))
        .filter(Boolean),
      serviceMetrics: serviceMetrics ? 'service-metrics.json' : null,
      dataChecks: 'data-checks.json',
      seedManifest: prepareResult?.manifestFile ?? null,
      k6ExitCode,
    },
    warnings: [...warnings, ...(times?.warnings ?? []), ...(serviceMetrics?.warnings ?? [])],
    notes: [...(moduleEvaluation.notes ?? [])],
  };
}
