/**
 * prometheus-text.mjs — reads the Prometheus text format that Spring Boot's /actuator/prometheus serves.
 *
 * What:    The services expose counters and gauges as text lines such as
 *            hikaricp_connections_pending{pool="cce-collector-pool"} 0.0
 *          This module parses those lines into a map (metric name → series with labels and value) and
 *          sums or maxes series by EXACT label values. A missing metric gives null, never an exception
 *          (v1 crashed or printed 0 when a metric was absent).
 * How:     import { scrapeMetrics, sumMetric } from './clients/prometheus-text.mjs';
 *          const parsed = await scrapeMetrics('http://localhost:8097/actuator/prometheus');
 *          sumMetric(parsed, 'cce_events_matched_total');   // sum over every series, or null
 * Needs:   Network access for scrapeMetrics only (tests use parsePrometheusText on fixture text).
 * Outputs: Map<string, Array<{labels: Record<string,string>, value: number}>>, numbers or null.
 */
import { getText } from './http-json.mjs';

/** One sample line: name, optional {labels}, value, optional timestamp. */
const SAMPLE_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(\S+)(\s+\S+)?$/;

/**
 * Parses the label part `a="x",b="y"` (values may contain escaped quotes, commas and braces).
 * Why: label values such as uri="/v1/events" or exception="None" must be matched exactly.
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseLabels(text) {
  const labels = {};
  const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
  for (const match of text.matchAll(pattern)) {
    // Undo the format's escapes: \" \\ \n.
    labels[match[1]] = match[2].replace(/\\(["\\n])/g, (_, c) => (c === 'n' ? '\n' : c));
  }
  return labels;
}

/**
 * Parses a whole Prometheus text exposition.
 * Why: one parse per scrape; every metric of the sampler is then looked up in the map.
 * @param {string} text
 * @returns {Map<string, Array<{labels: Record<string,string>, value: number}>>}
 */
export function parsePrometheusText(text) {
  const metrics = new Map();
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim();
    // Comments (# HELP, # TYPE) and blank lines carry no samples.
    if (line === '' || line.startsWith('#')) continue;
    const match = SAMPLE_LINE.exec(line);
    if (!match) continue;
    const [, name, , labelText, valueText] = match;
    const value = Number(valueText); // handles NaN, +Inf, -Inf as JavaScript numbers
    if (!metrics.has(name)) metrics.set(name, []);
    metrics.get(name).push({ labels: labelText ? parseLabels(labelText) : {}, value });
  }
  return metrics;
}

/**
 * Series of a metric whose labels equal every given filter value (exact match, no wildcards).
 * Why: plan §6.3 — exact filters keep "which series did we read" obvious.
 * @param {Map} parsed
 * @param {string} name
 * @param {Record<string,string>} labelFilter
 */
function matching(parsed, name, labelFilter) {
  const series = parsed?.get?.(name) ?? [];
  return series.filter((s) =>
    Object.entries(labelFilter).every(([label, value]) => s.labels[label] === value),
  );
}

/**
 * Sum of every matching series, or null when the metric (or a matching series) is absent.
 * Why: counters such as cce_events_matched_total are split by status; their sum is the total.
 * @param {Map} parsed
 * @param {string} name
 * @param {Record<string,string>} [labelFilter]
 * @returns {number|null}
 */
export function sumMetric(parsed, name, labelFilter = {}) {
  const series = matching(parsed, name, labelFilter).filter((s) => Number.isFinite(s.value));
  return series.length ? series.reduce((sum, s) => sum + s.value, 0) : null;
}

/**
 * Largest value of every matching series, or null when absent.
 * Why: gauges such as jvm_gc_pause_seconds_max are per GC; the worst one matters.
 * @param {Map} parsed
 * @param {string} name
 * @param {Record<string,string>} [labelFilter]
 * @returns {number|null}
 */
export function maxMetric(parsed, name, labelFilter = {}) {
  const series = matching(parsed, name, labelFilter).filter((s) => Number.isFinite(s.value));
  return series.length ? Math.max(...series.map((s) => s.value)) : null;
}

/**
 * Scrapes a metrics URL and parses it.
 * Why: the sampler, watchers and idle checks all scrape the same way.
 * @param {string} url
 * @param {{timeoutMs?: number, fetchFn?: typeof fetch}} [options]
 * @returns {Promise<Map>}
 */
export async function scrapeMetrics(url, { timeoutMs = 5000, fetchFn } = {}) {
  const { status, text } = await getText(url, { timeoutMs, fetchFn });
  if (status !== 200) throw new Error(`GET ${url} answered HTTP ${status}`);
  return parsePrometheusText(text);
}
