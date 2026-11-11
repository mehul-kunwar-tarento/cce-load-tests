/**
 * sampled-metrics.mjs — which service metrics are sampled during a run, and the "peaks" table (plan §6.3).
 *
 * What:    While a test runs, the sampler (metrics-sampler.mjs) reads each service's actuator metrics
 *          every WATCH_INTERVAL: DB pool (Hikari), heap, GC pauses, CPU, plus service-specific counters.
 *          Afterwards computePeaks() turns those samples into one number per signal (e.g. "most
 *          requests waiting for a DB connection: 7") and the moment it first crossed its "trouble"
 *          level. The report uses these as DIAGNOSTICS near the moment a service started breaking
 *          ("collector DB pool: requests waiting for a connection from 14:31:02"); they never decide
 *          pass or fail.
 * How:     import { COMMON_SAMPLED_METRICS, PEAK_SIGNALS, computePeaks } from './sampled-metrics.mjs';
 * Needs:   service-metrics.json written by the sampler: {intervalSeconds, targets, samples:[{at, service, metrics}]}.
 * Outputs: SampledMetric definitions and { [subject]: { [peakKey]: { value, firstAt } } }.
 */
import { readJsonFile } from './json-file.mjs';

/**
 * @typedef {{key:string, name:string, labels?:Record<string,string>, agg:'sum'|'max', unit:string}} SampledMetric
 *   key: name in samples[].metrics; name: plain Prometheus metric name; labels: EXACT label values
 *   (no wildcards); agg: how several series are combined.
 */

/** Metrics every service module gets (JVM, DB pool, CPU), plan §6.3. */
export const COMMON_SAMPLED_METRICS = Object.freeze([
  { key: 'hikariPending', name: 'hikaricp_connections_pending', agg: 'sum', unit: 'requests' },
  { key: 'hikariActive', name: 'hikaricp_connections_active', agg: 'sum', unit: 'connections' },
  { key: 'hikariMax', name: 'hikaricp_connections_max', agg: 'sum', unit: 'connections' },
  {
    key: 'hikariTimeouts',
    name: 'hikaricp_connections_timeout_total',
    agg: 'sum',
    unit: 'timeouts',
  },
  {
    key: 'heapUsed',
    name: 'jvm_memory_used_bytes',
    labels: { area: 'heap' },
    agg: 'sum',
    unit: 'bytes',
  },
  {
    key: 'heapMax',
    name: 'jvm_memory_max_bytes',
    labels: { area: 'heap' },
    agg: 'sum',
    unit: 'bytes',
  },
  { key: 'gcPauseMax', name: 'jvm_gc_pause_seconds_max', agg: 'max', unit: 'seconds' },
  { key: 'processCpu', name: 'process_cpu_usage', agg: 'max', unit: 'ratio' },
]);

/**
 * The fixed peaks table (plan §6.3). Each signal:
 *   peakKey   key in serviceMetrics.peaks.<subject>
 *   mode      'max' (largest sample), 'increase' (counter growth), 'mean-of-ratio' (Δsum/Δcount)
 *   sampled   sampled key(s) it needs (modules add service-specific keys with these names)
 *   trouble   (value, metrics) → true when this sample is "in trouble" (for firstAt); null = never
 *   scale     multiply the raw value (seconds → ms)
 *   services  'all' or a list of subjects
 *   label     words for diagnostics
 */
export const PEAK_SIGNALS = Object.freeze([
  {
    peakKey: 'hikariPendingMax',
    mode: 'max',
    sampled: ['hikariPending'],
    services: 'all',
    trouble: (value) => value > 0,
    label: 'DB pool: requests waiting for a connection',
  },
  {
    peakKey: 'hikariActiveMax',
    mode: 'max',
    sampled: ['hikariActive'],
    services: 'all',
    trouble: (value, metrics) =>
      metrics.hikariMax !== null && metrics.hikariMax !== undefined && value >= metrics.hikariMax,
    label: 'DB pool: every connection in use',
  },
  {
    peakKey: 'hikariTimeouts',
    mode: 'increase',
    sampled: ['hikariTimeouts'],
    services: 'all',
    trouble: (increase) => increase > 0,
    label: 'DB pool: connection requests timed out',
  },
  {
    peakKey: 'heapUsedMaxBytes',
    mode: 'max',
    sampled: ['heapUsed'],
    services: 'all',
    trouble: (value, metrics) => Boolean(metrics.heapMax) && value > 0.9 * metrics.heapMax,
    label: 'heap above 90 % of its maximum',
  },
  {
    peakKey: 'gcPauseMaxMs',
    mode: 'max',
    sampled: ['gcPauseMax'],
    services: 'all',
    scale: 1000,
    trouble: (ms) => ms > 500,
    label: 'garbage-collection pause over 500 ms',
  },
  {
    peakKey: 'processCpuMax',
    mode: 'max',
    sampled: ['processCpu'],
    services: 'all',
    trouble: null,
    label: 'process CPU (share of the host)',
  },
  {
    peakKey: 'processingMsAvg',
    mode: 'mean-of-ratio',
    sampled: ['processingSecondsSum', 'processingSecondsCount'],
    services: ['matcher'],
    scale: 1000,
    trouble: null,
    label: 'average processing time per event',
  },
  {
    peakKey: 'kafkaPublishFailures',
    mode: 'increase',
    sampled: ['kafkaPublishFailures'],
    services: ['collector'],
    trouble: (increase) => increase > 0,
    label: 'Kafka publish failures',
  },
  {
    peakKey: 'slaBatchesFailed',
    mode: 'increase',
    sampled: ['slaBatchesFailed'],
    services: ['step-sla'],
    trouble: (increase) => increase > 0,
    label: 'Step SLA evaluator batches failed',
  },
]);

/** Label of a peak key, including slaCycleCapHits which comes from the alarm watcher (not sampled). */
export function peakLabel(peakKey) {
  if (peakKey === 'slaCycleCapHits') return 'Step SLA hit the 10,000-rows-per-cycle cap';
  return PEAK_SIGNALS.find((signal) => signal.peakKey === peakKey)?.label ?? peakKey;
}

/** True when a signal applies to a subject; why: matcher-only signals are not computed for others. */
function appliesTo(signal, subject) {
  return signal.services === 'all' || signal.services.includes(subject);
}

/**
 * Computes one signal for one service's samples.
 * Why: separates the three modes; returns null when the needed metrics were never present.
 * @param {object} signal
 * @param {Array<{at:string, metrics:Record<string, number|null>}>} samples
 * @returns {{value:number, firstAt:string|null}|null}
 */
function computeSignal(signal, samples) {
  const scale = signal.scale ?? 1;
  const [key] = signal.sampled;
  const present = samples.filter((s) => typeof s.metrics?.[key] === 'number');
  if (!present.length) return null;

  if (signal.mode === 'max') {
    let value = -Infinity;
    let firstAt = null;
    for (const sample of present) {
      const scaled = sample.metrics[key] * scale;
      value = Math.max(value, scaled);
      if (firstAt === null && signal.trouble?.(scaled, sample.metrics)) firstAt = sample.at;
    }
    return { value, firstAt };
  }

  if (signal.mode === 'increase') {
    // Sum of positive steps: a counter reset (service restart) does not produce a negative increase.
    let increase = 0;
    let firstAt = null;
    for (let i = 1; i < present.length; i += 1) {
      const step = present[i].metrics[key] - present[i - 1].metrics[key];
      if (step > 0) increase += step;
      if (firstAt === null && signal.trouble?.(increase, present[i].metrics))
        firstAt = present[i].at;
    }
    return { value: increase * scale, firstAt };
  }

  // mean-of-ratio: (last sum − first sum) / (last count − first count), e.g. seconds per event.
  const [sumKey, countKey] = signal.sampled;
  const both = samples.filter(
    (s) => typeof s.metrics?.[sumKey] === 'number' && typeof s.metrics?.[countKey] === 'number',
  );
  if (both.length < 2) return null;
  const first = both[0].metrics;
  const last = both[both.length - 1].metrics;
  const count = last[countKey] - first[countKey];
  if (count <= 0) return null;
  return { value: ((last[sumKey] - first[sumKey]) / count) * scale, firstAt: null };
}

/**
 * Peaks per service from a service-metrics.json (object or file path).
 * Why: result.serviceMetrics.peaks (plan §5.2) and the diagnostics of the breaking analysis.
 * @param {string|{samples: Array<{at:string, service:string, metrics:object}>}} serviceMetricsFile
 * @returns {Record<string, Record<string, {value:number, firstAt:string|null}>>}
 */
export function computePeaks(serviceMetricsFile) {
  const data =
    typeof serviceMetricsFile === 'string' ? readJsonFile(serviceMetricsFile) : serviceMetricsFile;
  const bySubject = new Map();
  for (const sample of data?.samples ?? []) {
    if (!bySubject.has(sample.service)) bySubject.set(sample.service, []);
    bySubject.get(sample.service).push(sample);
  }
  const peaks = {};
  for (const [subject, samples] of bySubject) {
    // Samples are appended in time order by the sampler; sort anyway for files merged by hand.
    samples.sort((a, b) => new Date(a.at) - new Date(b.at));
    peaks[subject] = {};
    for (const signal of PEAK_SIGNALS) {
      if (!appliesTo(signal, subject)) continue;
      const result = computeSignal(signal, samples);
      if (result) peaks[subject][signal.peakKey] = result;
    }
  }
  return peaks;
}
