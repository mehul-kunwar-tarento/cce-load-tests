/**
 * breaking-analysis.mjs — "when did it start breaking, and what broke?" (plan §6.9, R1.2).
 *
 * What:    Answers the team lead's questions for stress and breakpoint runs from JSON only:
 *          - windows (load/stress/flood): the measured phase is cut into report windows; a window is
 *            broken when its p95 or error rate is over the limit, its checks are under the limit, or k6
 *            sent fewer than (1 − RATE_SHORTFALL_TOLERANCE) × planned ("k6 could not send on time").
 *            "Started breaking" = the start of the first BREAK_CONSECUTIVE_WINDOWS broken windows in a row.
 *          - staircase levels (HTTP breakpoint): each level held or broke; held up to / broke at.
 *          - backlog series (matcher): first time the backlog stayed above the limit.
 *          - the k6 limit (D9): broken only by dropped/short sending while the service answered fast
 *            (p95 < K6_LIMIT_P95_MS) means the LOAD GENERATOR was the limit → "at least X/s (k6 limit)".
 *          - diagnostics: service signals (DB pool waiting, GC pause …) that first went bad within ±1
 *            window of the break; they explain, never decide.
 *          All clock times = measureStart (k6 clock contract) + offset, never the docker start time.
 * How:     import { analyseWindows, analyseLevels, analyseBacklogSeries, diagnosticsNear } from './breaking-analysis.mjs';
 * Needs:   A normalised k6 summary (k6-summary.mjs), the phase plan, ResolvedSettings.values, measureStart.
 * Outputs: Plain objects that the result builder copies into result.json (breaking, levels, timeSeries).
 */
import { formatClock, formatNumber, formatPercent, toIsoWithOffset } from './format.mjs';
import {
  failedThresholds,
  metricValue,
  parseMetricKey,
  parseRule,
  subMetric,
} from './k6-summary.mjs';
import { measuredPhaseOf } from './lib-bridge.mjs';
import { peakLabel } from './sampled-metrics.mjs';

/** Seconds of slack when deciding whether a window/level was fully run before k6 stopped. */
const SLACK_SECONDS = 1;

/** ISO time of measureStart + seconds, or null when measureStart is unknown. */
function atOffset(measureStart, seconds) {
  if (!measureStart) return null;
  return toIsoWithOffset(new Date(measureStart).getTime() + seconds * 1000);
}

/**
 * Seconds of the measured phase that k6 actually ran (Infinity when unknown).
 * Why: windows/levels after an abort were never reached and must not count as "short".
 */
function measuredSecondsRun(normalised, measured) {
  const durationMs = normalised?.durationMs;
  return typeof durationMs === 'number' ? durationMs / 1000 - measured.startSeconds : Infinity;
}

/**
 * Levels of a staircase with their offset into the measured phase (cumulative durations).
 * Why: independent of whether Level.startSeconds counts from the k6 start or the phase start.
 */
function levelsWithOffsets(measured) {
  let offset = 0;
  return (measured.levels ?? []).map((level) => {
    const entry = { ...level, offsetSeconds: offset };
    offset += level.durationSeconds;
    return entry;
  });
}

/** Rate scheduled at an offset into the measured phase. */
function rateAtOffset(measured, offsetSeconds) {
  if (measured.kind !== 'staircase') return measured.rate;
  const levels = levelsWithOffsets(measured);
  const level = levels.find(
    (l) => offsetSeconds >= l.offsetSeconds && offsetSeconds < l.offsetSeconds + l.durationSeconds,
  );
  return (level ?? levels[levels.length - 1])?.rate ?? measured.rate;
}

/** p95 of the measured scenario (or of all requests when the scenario sub-metric is absent). */
export function measuredP95(normalised, phasePlan) {
  const scenario = phasePlan?.measuredPhase ?? 'measure';
  return (
    metricValue(normalised, `http_req_duration{scenario:${scenario}}`, 'p(95)') ??
    metricValue(normalised, 'http_req_duration', 'p(95)')
  );
}

/**
 * Index of the first run of `consecutive` broken items in a row, or -1.
 * Why: one slow window is noise; BREAK_CONSECUTIVE_WINDOWS in a row is a trend (plan §6.9).
 * @param {boolean[]} broken
 * @param {number} consecutive
 */
export function firstBreak(broken, consecutive) {
  const needed = Math.max(1, consecutive || 1);
  let run = 0;
  for (let i = 0; i < broken.length; i += 1) {
    run = broken[i] ? run + 1 : 0;
    if (run >= needed) return i - needed + 1;
  }
  return -1;
}

/**
 * True when the run's only failed k6 rules are about dropped iterations / sending on time.
 * Why: the D9 k6-limit rule applies only when nothing about the service itself failed.
 */
function onlySendingRulesFailed(normalised) {
  return failedThresholds(normalised).every(({ key }) => {
    const { name } = parseMetricKey(key);
    return name === 'dropped_iterations' || name === 'iterations';
  });
}

/**
 * Window analysis for load, stress and flood runs (plan §6.9 "Windows").
 * @param {object} input
 * @param {ReturnType<import('./k6-summary.mjs').normaliseK6Summary>} input.normalised
 * @param {object} input.phasePlan
 * @param {Record<string, any>} input.settings ResolvedSettings.values
 * @param {string|null} input.measureStart ISO
 * @param {'http'|'kafka'} [input.kind] latency/error rules exist only for HTTP
 * @returns {{points:object[], startedBreakingAt:string|null, secondsIntoMeasure:number|null, rateAtBreak:number|null,
 *            whatBroke:object[], k6Limited:boolean, brokenWindows:number}}
 */
export function analyseWindows({ normalised, phasePlan, settings, measureStart, kind = 'http' }) {
  const measured = measuredPhaseOf(phasePlan);
  const empty = {
    points: [],
    startedBreakingAt: null,
    secondsIntoMeasure: null,
    rateAtBreak: null,
    whatBroke: [],
    k6Limited: false,
    brokenWindows: 0,
  };
  if (!measured || !(measured.durationSeconds > 0) || !phasePlan.windowCount) return empty;

  const ran = measuredSecondsRun(normalised, measured);
  const tolerance = settings.RATE_SHORTFALL_TOLERANCE ?? 0.05;
  const points = [];
  const reasonsPerPoint = [];
  for (let i = 0; i < phasePlan.windowCount; i += 1) {
    const start = i * phasePlan.windowSeconds;
    const end = Math.min(start + phasePlan.windowSeconds, measured.durationSeconds);
    if (start >= ran) break; // k6 stopped before this window
    const sent = subMetric(normalised, 'iterations', 'window', i)?.values?.count ?? null;
    const p95 = subMetric(normalised, 'http_req_duration', 'window', i)?.values?.['p(95)'] ?? null;
    const failedRate = subMetric(normalised, 'http_req_failed', 'window', i)?.values?.rate ?? null;
    const checksRate = subMetric(normalised, 'checks', 'window', i)?.values?.rate ?? null;
    const rate = rateAtOffset(measured, start);
    const expected = rate * (end - start);
    const reasons = [];
    if (kind === 'http' && p95 !== null && p95 > settings.HTTP_P95_LIMIT_MS)
      reasons.push({ kind: 'latency', actual: p95 });
    if (kind === 'http' && failedRate !== null && failedRate > settings.HTTP_MAX_FAILED_RATE)
      reasons.push({ kind: 'errors', actual: failedRate });
    if (checksRate !== null && checksRate < settings.MIN_CHECKS_RATE)
      reasons.push({ kind: 'checks', actual: checksRate });
    // Only a window k6 ran completely can be "short"; a missing sub-metric is no evidence.
    const complete = end <= ran + SLACK_SECONDS;
    if (complete && sent !== null && sent < (1 - tolerance) * expected) {
      reasons.push({ kind: 'shortfall', actual: sent, expected });
    }
    reasonsPerPoint.push(reasons);
    points.push({
      t: start,
      at: atOffset(measureStart, start),
      phase: measured.name,
      level: measured.kind === 'staircase' ? rate : null,
      sent,
      sentPerSecond: sent === null || end <= start ? null : sent / (end - start),
      p95Ms: p95,
      failedRate,
      backlog: null,
      processedPerSecond: null,
      broken: reasons.length > 0,
    });
  }

  const index = firstBreak(
    points.map((p) => p.broken),
    settings.BREAK_CONSECUTIVE_WINDOWS,
  );
  const brokenReasons = reasonsPerPoint.filter((r) => r.length).flat();
  const whatBroke = describeWindowReasons(brokenReasons, settings);

  // k6 limit (D9): only sending problems, and the service answered fast.
  const p95 = measuredP95(normalised, phasePlan);
  const dropped = metricValue(normalised, 'dropped_iterations', 'count') ?? 0;
  const failed = failedThresholds(normalised);
  const sendingOnly =
    brokenReasons.every((r) => r.kind === 'shortfall') && onlySendingRulesFailed(normalised);
  const somethingFailed = failed.length > 0 || brokenReasons.length > 0;
  const k6Limited =
    kind === 'http' &&
    somethingFailed &&
    sendingOnly &&
    p95 !== null &&
    p95 < settings.K6_LIMIT_P95_MS;
  if (k6Limited) {
    const shortBy = Math.round(brokenReasons.reduce((sum, r) => sum + (r.expected - r.actual), 0));
    const notSent = dropped > 0 ? dropped : shortBy;
    whatBroke.splice(0, whatBroke.length, {
      metric: 'k6-limit',
      description: `k6 could not send ${formatNumber(notSent)} on time (k6 limit, service p95 ${formatNumber(p95)} ms)`,
      actual: notSent,
      limit: null,
      source: 'k6',
    });
  }

  return {
    points,
    startedBreakingAt: index >= 0 ? points[index].at : null,
    secondsIntoMeasure: index >= 0 ? points[index].t : null,
    rateAtBreak: index >= 0 ? rateAtOffset(measured, points[index].t) : null,
    whatBroke,
    k6Limited,
    brokenWindows: points.filter((p) => p.broken).length,
  };
}

/**
 * Turns window reasons into "what broke" entries (worst value per kind).
 * Why: the report lists each kind of failure once, with the worst number seen.
 */
function describeWindowReasons(reasons, settings) {
  const entries = [];
  const worst = (kind, pick) => reasons.filter((r) => r.kind === kind).reduce(pick, null);
  const maxOf = (acc, r) => (acc === null || r.actual > acc ? r.actual : acc);
  const minOf = (acc, r) => (acc === null || r.actual < acc ? r.actual : acc);
  const latency = worst('latency', maxOf);
  if (latency !== null) {
    entries.push({
      metric: 'http_req_duration',
      description: `p95 up to ${formatNumber(latency)} ms (rule < ${formatNumber(settings.HTTP_P95_LIMIT_MS)} ms)`,
      actual: latency,
      limit: settings.HTTP_P95_LIMIT_MS,
      source: 'k6',
    });
  }
  const errors = worst('errors', maxOf);
  if (errors !== null) {
    entries.push({
      metric: 'http_req_failed',
      description: `up to ${formatPercent(errors)} of requests failed (rule < ${formatPercent(settings.HTTP_MAX_FAILED_RATE)})`,
      actual: errors,
      limit: settings.HTTP_MAX_FAILED_RATE,
      source: 'k6',
    });
  }
  const checks = worst('checks', minOf);
  if (checks !== null) {
    entries.push({
      metric: 'checks',
      description: `only ${formatPercent(checks)} of checks passed (rule > ${formatPercent(settings.MIN_CHECKS_RATE)})`,
      actual: checks,
      limit: settings.MIN_CHECKS_RATE,
      source: 'k6',
    });
  }
  const shortfalls = reasons.filter((r) => r.kind === 'shortfall');
  if (shortfalls.length) {
    const notSent = Math.round(shortfalls.reduce((sum, r) => sum + (r.expected - r.actual), 0));
    entries.push({
      metric: 'iterations',
      description: `${formatNumber(notSent)} events k6 could not send on time`,
      actual: notSent,
      limit: null,
      source: 'k6',
    });
  }
  return entries;
}

/**
 * Staircase analysis (plan §6.9 "Staircase").
 * @param {object} input
 * @param {ReturnType<import('./k6-summary.mjs').normaliseK6Summary>} input.normalised
 * @param {object} input.phasePlan
 * @param {Record<string, any>} input.settings
 * @param {string|null} input.measureStart ISO
 * @returns {{levels:object[], heldUpTo:number|null, brokeAtRate:number|null, startedBreakingAt:string|null,
 *            secondsIntoMeasure:number|null, k6Limited:boolean, whatBroke:object[]}}
 */
export function analyseLevels({ normalised, phasePlan, settings, measureStart }) {
  const measured = measuredPhaseOf(phasePlan);
  if (!measured || measured.kind !== 'staircase') {
    return {
      levels: [],
      heldUpTo: null,
      brokeAtRate: null,
      startedBreakingAt: null,
      secondsIntoMeasure: null,
      k6Limited: false,
      whatBroke: [],
    };
  }
  const ran = measuredSecondsRun(normalised, measured);
  const tolerance = settings.RATE_SHORTFALL_TOLERANCE ?? 0.05;
  const failed = failedThresholds(normalised);

  const levels = levelsWithOffsets(measured).map((level) => {
    const tag = String(level.rate);
    const requests = subMetric(normalised, 'iterations', 'level', tag)?.values?.count ?? null;
    const p95 = subMetric(normalised, 'http_req_duration', 'level', tag)?.values?.['p(95)'] ?? null;
    const failedRate = subMetric(normalised, 'http_req_failed', 'level', tag)?.values?.rate ?? null;
    const checksRate = subMetric(normalised, 'checks', 'level', tag)?.values?.rate ?? null;
    const reached = level.offsetSeconds < ran && (requests ?? 0) > 0;
    const reasons = [];
    const kinds = [];
    if (reached) {
      // Failed per-level k6 rules (abortOnFail rules of plan §4.2).
      for (const { key, rule } of failed) {
        const parsedKey = parseMetricKey(key);
        if (parsedKey.tags.level !== tag) continue;
        const parsedRule = parseRule(rule);
        const actual = parsedRule ? normalised.metrics[key]?.values?.[parsedRule.stat] : null;
        reasons.push(levelReason(parsedKey.name, parsedRule, actual));
        kinds.push(parsedKey.name === 'iterations' ? 'shortfall' : 'service');
      }
      const complete = level.offsetSeconds + level.durationSeconds <= ran + SLACK_SECONDS;
      if (complete && requests !== null && requests < (1 - tolerance) * level.plannedEvents) {
        reasons.push(
          `sent ${formatNumber(requests)} of ${formatNumber(level.plannedEvents)} planned (k6 could not send on time)`,
        );
        kinds.push('shortfall');
      }
    }
    return {
      rate: level.rate,
      startedAt: atOffset(measureStart, level.offsetSeconds),
      endedAt: atOffset(measureStart, level.offsetSeconds + level.durationSeconds),
      plannedEvents: level.plannedEvents,
      requests,
      // k6 lists unreached sub-metrics with zeros: a level never reached has no latency at all.
      p95Ms: reached ? p95 : null,
      failedRate: reached ? failedRate : null,
      checksRate: reached ? checksRate : null,
      result: !reached ? 'not-reached' : reasons.length ? 'broke' : 'held',
      reasons,
      offsetSeconds: level.offsetSeconds,
      reasonKinds: kinds,
    };
  });

  // The run's dropped-iterations rule failed but no level broke: the top level reached broke (plan §6.9).
  const droppedFailed = failed.some(
    ({ key }) =>
      parseMetricKey(key).name === 'dropped_iterations' && !parseMetricKey(key).tags.level,
  );
  if (droppedFailed && !levels.some((l) => l.result === 'broke')) {
    const top = [...levels].reverse().find((l) => l.result === 'held');
    if (top) {
      const dropped = metricValue(normalised, 'dropped_iterations', 'count') ?? 0;
      top.result = 'broke';
      top.reasons.push(`k6 dropped ${formatNumber(dropped)}`);
      top.reasonKinds.push('dropped');
    }
  }

  const firstBroken = levels.find((l) => l.result === 'broke') ?? null;
  // Held up to = the highest level with nothing broken at or below it.
  let heldUpTo = null;
  for (const level of levels) {
    if (level.result !== 'held') break;
    heldUpTo = level.rate;
  }
  const k6Limited = Boolean(
    firstBroken &&
    firstBroken.reasonKinds.every((k) => k === 'shortfall' || k === 'dropped') &&
    firstBroken.p95Ms !== null &&
    firstBroken.p95Ms < settings.K6_LIMIT_P95_MS,
  );
  const whatBroke = firstBroken
    ? [
        {
          metric: k6Limited ? 'k6-limit' : 'level',
          description: k6Limited
            ? `at ${formatNumber(firstBroken.rate)}/s k6 could not send on time while p95 was ${formatNumber(firstBroken.p95Ms)} ms: at least ${formatNumber(heldUpTo ?? firstBroken.rate)}/s (k6 limit)`
            : `at ${formatNumber(firstBroken.rate)}/s: ${firstBroken.reasons.join('; ')}`,
          actual: firstBroken.rate,
          limit: null,
          source: 'k6',
        },
      ]
    : [];

  return {
    // Internal helper fields are dropped from what goes into result.json.
    levels: levels.map(({ offsetSeconds: _o, reasonKinds: _k, ...rest }) => rest),
    heldUpTo,
    brokeAtRate: firstBroken?.rate ?? null,
    startedBreakingAt: firstBroken?.startedAt ?? null,
    secondsIntoMeasure: firstBroken ? firstBroken.offsetSeconds : null,
    k6Limited,
    whatBroke,
  };
}

/** Words for one failed per-level rule; why: "p95 666 ms (rule < 500 ms)" instead of "p(95)<500". */
function levelReason(metric, rule, actual) {
  const value = typeof actual === 'number' ? actual : null;
  if (!rule) return `${metric} rule failed`;
  if (metric === 'http_req_duration')
    return `p95 ${formatNumber(value)} ms (rule ${rule.op} ${formatNumber(rule.limit)} ms)`;
  if (metric === 'http_req_failed')
    return `${formatPercent(value)} failed (rule ${rule.op} ${formatPercent(rule.limit)})`;
  if (metric === 'checks')
    return `${formatPercent(value)} of checks passed (rule ${rule.op} ${formatPercent(rule.limit)})`;
  return `${metric} ${formatNumber(value)} (rule ${rule.stat} ${rule.op} ${formatNumber(rule.limit)})`;
}

/**
 * Backlog analysis (matcher): first sample of the measured phase that starts `consecutive` samples in
 * a row above the limit (plan §6.9 "Backlog series").
 * @param {{samples:Array<{at:string, backlog:number|null}>, limit:number, consecutive:number, measureStart:string|null}} input
 * @returns {{startedBreakingAt:string|null, secondsIntoMeasure:number|null, maxBacklog:number|null}}
 */
export function analyseBacklogSeries({ samples, limit, consecutive, measureStart }) {
  const startMs = measureStart ? new Date(measureStart).getTime() : -Infinity;
  const inMeasure = (samples ?? []).filter((s) => new Date(s.at).getTime() >= startMs);
  const numeric = inMeasure.map((s) => s.backlog).filter((b) => typeof b === 'number');
  const maxBacklog = numeric.length ? Math.max(...numeric) : null;
  const index = firstBreak(
    inMeasure.map((s) => typeof s.backlog === 'number' && s.backlog > limit),
    consecutive,
  );
  if (index < 0) return { startedBreakingAt: null, secondsIntoMeasure: null, maxBacklog };
  const at = inMeasure[index].at;
  return {
    startedBreakingAt: at,
    secondsIntoMeasure: measureStart
      ? Math.round((new Date(at).getTime() - startMs) / 100) / 10
      : null,
    maxBacklog,
  };
}

/**
 * Diagnostics: service signals whose first "trouble" lies within ±1 window of the break (plan §6.9).
 * Why: tells a developer where to look ("matcher DB pool waiting from 14:31:02"); never changes a verdict.
 * @param {{peaks:Record<string, Record<string, {value:number, firstAt:string|null}>>|null, startedBreakingAt:string|null, windowSeconds:number}} input
 * @returns {object[]} whatBroke entries with source 'service-metrics'
 */
export function diagnosticsNear({ peaks, startedBreakingAt, windowSeconds }) {
  if (!peaks || !startedBreakingAt) return [];
  const breakMs = new Date(startedBreakingAt).getTime();
  const entries = [];
  for (const [subject, signals] of Object.entries(peaks)) {
    for (const [peakKey, peak] of Object.entries(signals ?? {})) {
      if (!peak?.firstAt) continue;
      const distance = Math.abs(new Date(peak.firstAt).getTime() - breakMs);
      if (distance > windowSeconds * 1000) continue;
      entries.push({
        metric: peakKey,
        description: `${subject} ${peakLabel(peakKey)} from ${formatClock(peak.firstAt)} (diagnostic)`,
        actual: peak.value,
        limit: null,
        source: 'service-metrics',
        firstAt: peak.firstAt,
      });
    }
  }
  return entries;
}
