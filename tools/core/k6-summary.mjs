/**
 * k6-summary.mjs — reads k6's end-of-test summary (k6-summary.json) in one tolerant, normalised shape.
 *
 * What:    At the end of every test, lib/summary.js (handleSummary) saves k6's numbers: per metric
 *          (http_req_duration, events_sent, dropped_iterations, …) and per sub-metric
 *          ("http_req_duration{level:400}", "iterations{window:3}") the values (count, rate, p95, …)
 *          and whether each threshold rule passed. Two shapes exist: handleSummary's
 *          { values:{…}, thresholds:{rule:{ok}} } and --summary-export's flat values with
 *          thresholds {rule: true = crossed}. Both are normalised here (plan §5.3), and the k6 rules are
 *          turned into the result's Threshold objects; summary-forcing "dummy" rules (count>=0, …) are
 *          dropped because they never decide anything.
 * How:     import { normaliseK6Summary, thresholdsFromK6, subMetric } from './k6-summary.mjs';
 *          const normalised = normaliseK6Summary(readJson('results/…/k6-summary.json'));
 * Needs:   A k6 summary object (A1 fixture: lib/unit-tests/fixtures/k6-summary-sample.json).
 * Outputs: { metrics: {key: {type, values, thresholds:{rule:{ok}}}}, context, durationMs } and Threshold[].
 */
import { describeThreshold, isDummyRule } from './lib-bridge.mjs';
import { loadSettingDefinitions } from './settings.mjs';

/** Keys of a metric entry that are not values (the rest are values in --summary-export shape). */
const NON_VALUE_KEYS = new Set(['type', 'contains', 'thresholds', 'values']);

/** Which setting holds the limit of a k6 rule on a metric (for the "to be confirmed" flag). */
const LIMIT_SETTING = {
  http_req_duration: 'HTTP_P95_LIMIT_MS',
  http_req_failed: 'HTTP_MAX_FAILED_RATE',
  checks: 'MIN_CHECKS_RATE',
  dropped_iterations: 'MAX_DROPPED_RATE',
  kafka_writer_error_count: 'MATCHER_MAX_KAFKA_WRITE_ERRORS',
};

/**
 * Normalises a raw k6 summary.
 * Why: every later step reads one shape, whatever k6 output mode produced the file.
 * @param {any} raw parsed k6-summary.json (or --summary-export output)
 * @returns {{metrics: Record<string, {type:string|null, values:Record<string, number>, thresholds:Record<string,{ok:boolean}>}>,
 *            context: object|null, durationMs: number|null}}
 */
export function normaliseK6Summary(raw) {
  const metrics = {};
  for (const [key, entry] of Object.entries(raw?.metrics ?? {})) {
    const values = entry?.values
      ? { ...entry.values }
      : Object.fromEntries(
          Object.entries(entry ?? {}).filter(([name]) => !NON_VALUE_KEYS.has(name)),
        );
    // --summary-export calls a rate's share "value"; handleSummary calls it "rate".
    if (
      values.rate === undefined &&
      values.value !== undefined &&
      ('passes' in values || 'fails' in values)
    ) {
      values.rate = values.value;
    }
    const thresholds = {};
    for (const [rule, state] of Object.entries(entry?.thresholds ?? {})) {
      // handleSummary: {ok: true}; --summary-export: true means the threshold was CROSSED (failed).
      thresholds[rule] = { ok: typeof state === 'boolean' ? !state : Boolean(state?.ok) };
    }
    metrics[key] = { type: entry?.type ?? null, values, thresholds };
  }
  return {
    metrics,
    context: raw?.context ?? null,
    durationMs: raw?.state?.testRunDurationMs ?? raw?.context?.testRunDurationMs ?? null,
  };
}

/**
 * Splits a summary key such as 'http_req_duration{level:400}' into name and tags.
 * Why: sub-metrics are found by their tag values, whatever order k6 wrote multiple tags in.
 * @param {string} key
 * @returns {{name:string, tags:Record<string,string>}}
 */
export function parseMetricKey(key) {
  const match = /^([^{]+)(?:\{(.*)\})?$/.exec(key);
  const tags = {};
  for (const part of (match?.[2] ?? '').split(',').filter(Boolean)) {
    const index = part.indexOf(':');
    tags[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return { name: match?.[1] ?? key, tags };
}

/**
 * One sub-metric, e.g. ('http_req_duration', 'level', '400'), or the whole metric when tag is omitted.
 * Why: per-level and per-window numbers drive the breaking analysis (plan §6.9).
 * @param {ReturnType<typeof normaliseK6Summary>} normalised
 * @param {string} metric
 * @param {string} [tag]
 * @param {string|number} [value]
 * @returns {{type:string|null, values:object, thresholds:object}|null}
 */
export function subMetric(normalised, metric, tag, value) {
  const metrics = normalised?.metrics ?? {};
  if (tag === undefined) return metrics[metric] ?? null;
  const exact = metrics[`${metric}{${tag}:${value}}`];
  if (exact) return exact;
  // Fallback: a key with extra tags or spaces, e.g. 'iterations{scenario:measure,window:3}' is NOT a match
  // for a single-tag lookup; only a key whose only tag is this one counts.
  for (const [key, entry] of Object.entries(metrics)) {
    const parsed = parseMetricKey(key);
    const names = Object.keys(parsed.tags);
    if (parsed.name === metric && names.length === 1 && parsed.tags[tag] === String(value))
      return entry;
  }
  return null;
}

/**
 * Parses a k6 rule such as 'p(95)<500', 'rate<0.01', 'count<=30'.
 * Why: limit and actual value are reported separately ("p95 666 ms, rule < 500 ms").
 * @param {string} rule
 * @returns {{stat:string, op:string, limit:number}|null}
 */
export function parseRule(rule) {
  const match = /^\s*([a-z]+(?:\([\d.]+\))?)\s*(<=|>=|==|!=|<|>)\s*([-\d.eE+]+)\s*$/.exec(
    String(rule),
  );
  return match ? { stat: match[1], op: match[2], limit: Number(match[3]) } : null;
}

/**
 * Every failed, non-dummy k6 rule.
 * Why: "what broke" and the status come from real rules only (plan §5.3).
 * @param {ReturnType<typeof normaliseK6Summary>} normalised
 * @returns {Array<{key:string, rule:string}>}
 */
export function failedThresholds(normalised) {
  const failed = [];
  for (const [key, metric] of Object.entries(normalised?.metrics ?? {})) {
    for (const [rule, state] of Object.entries(metric.thresholds)) {
      if (!state.ok && !isDummyRule(rule)) failed.push({ key, rule });
    }
  }
  return failed;
}

/**
 * The k6 rules as result Threshold objects (one per non-dummy rule, plan §5.3).
 * Why: result.thresholds starts from these; modules add only their own rules.
 * @param {ReturnType<typeof normaliseK6Summary>} normalised
 * @param {Record<string, any>} settings ResolvedSettings.values
 * @param {'http'|'kafka'|string} [_kind] reserved (rules already say which metric they are on)
 * @param {{definitions?: object}} [options]
 * @returns {object[]} Threshold[]
 */
export function thresholdsFromK6(
  normalised,
  settings,
  _kind,
  { definitions = loadSettingDefinitions() } = {},
) {
  const thresholds = [];
  const usedIds = new Set();
  for (const [key, metric] of Object.entries(normalised?.metrics ?? {})) {
    const { name, tags } = parseMetricKey(key);
    for (const [rule, state] of Object.entries(metric.thresholds)) {
      if (isDummyRule(rule)) continue;
      const parsed = parseRule(rule);
      const described = describeThreshold(key, rule);
      // Id: k6.<metric>[.<tag:value>], made unique when one key carries several rules.
      const tagText = Object.entries(tags)
        .map(([tag, value]) => `${tag}:${value}`)
        .join(',');
      let id = `k6.${name}${tagText ? `.${tagText}` : ''}`;
      for (let n = 2; usedIds.has(id); n += 1)
        id = `k6.${name}${tagText ? `.${tagText}` : ''}#${n}`;
      usedIds.add(id);
      // The setting behind the limit decides whether the rule is still "to be confirmed".
      let setting = LIMIT_SETTING[name] ?? null;
      if (
        name === 'dropped_iterations' &&
        parsed &&
        parsed.limit === settings?.BREAKPOINT_MAX_DROPPED
      ) {
        setting = 'BREAKPOINT_MAX_DROPPED';
      }
      const actual = parsed ? (metric.values[parsed.stat] ?? null) : null;
      thresholds.push({
        id,
        metric: key,
        rule: parsed ? `${parsed.stat} ${parsed.op} ${parsed.limit}` : rule,
        limit: parsed?.limit ?? null,
        actual: typeof actual === 'number' ? actual : null,
        unit: described.unit ?? '',
        passed: Boolean(state.ok),
        toBeConfirmed: Boolean(setting && definitions[setting]?.toBeConfirmed),
        source: 'k6',
        description: described.description,
      });
    }
  }
  return thresholds;
}

/**
 * When k6 started measuring, from the summary context written by lib/summary.js (authoritative).
 * Why: the result re-bases every time on this instead of the live REST estimate (plan §6.2 step 9).
 * @param {ReturnType<typeof normaliseK6Summary>} normalised
 * @returns {{k6StartedAt:string|null, testRunDurationMs:number|null}}
 */
export function k6Timing(normalised) {
  return {
    k6StartedAt: normalised?.context?.k6StartedAt ?? null,
    testRunDurationMs: normalised?.durationMs ?? null,
  };
}

/**
 * A metric value or null, e.g. metricValue(n, 'events_sent{scenario:measure}', 'count').
 * Why: shorthand used by the result builder; missing metrics are null, never 0.
 * @param {ReturnType<typeof normaliseK6Summary>} normalised
 * @param {string} key
 * @param {string} stat
 * @returns {number|null}
 */
export function metricValue(normalised, key, stat) {
  const value = normalised?.metrics?.[key]?.values?.[stat];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
