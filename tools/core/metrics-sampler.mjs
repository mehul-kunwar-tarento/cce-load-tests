/**
 * metrics-sampler.mjs — samples the services' actuator metrics into service-metrics.json during a run.
 *
 * What:    Every WATCH_INTERVAL, for each target service, scrape /actuator/prometheus and record the
 *          configured metrics (plain names, exact label filters, no wildcards). The file is rewritten
 *          after every round, so an aborted run still keeps what was sampled. A missing metric or an
 *          unreachable service records null (with a warning in the file), it never stops the run.
 * How:     const sampler = startMetricsSampler({ targets: [{ subject: 'matcher', url }], intervalSeconds: 5,
 *                                               file, metrics: [...COMMON_SAMPLED_METRICS, ...module.sampledMetrics] });
 *          …; await sampler.stop();
 * Needs:   A scrape function (default: clients/prometheus-text.mjs scrapeMetrics); tests pass a fake.
 * Outputs: service-metrics.json {intervalSeconds, targets, samples:[{at, t, service, metrics}], warnings}.
 */
import { maxMetric, scrapeMetrics, sumMetric } from './clients/prometheus-text.mjs';
import { toIsoWithOffset } from './format.mjs';
import { writeJson } from './results.mjs';

/**
 * Reads the configured metrics from one parsed scrape.
 * Why: one sample = one value per SampledMetric key (null when absent).
 * @param {Map} parsed
 * @param {Array<{key:string, name:string, labels?:object, agg:'sum'|'max'}>} metrics
 * @returns {Record<string, number|null>}
 */
export function readSample(parsed, metrics) {
  const values = {};
  for (const metric of metrics) {
    values[metric.key] =
      metric.agg === 'max'
        ? maxMetric(parsed, metric.name, metric.labels ?? {})
        : sumMetric(parsed, metric.name, metric.labels ?? {});
  }
  return values;
}

/**
 * Starts the sampler.
 * @param {object} input
 * @param {Array<{subject:string, url:string}>} input.targets
 * @param {number} input.intervalSeconds
 * @param {string} input.file service-metrics.json path
 * @param {Array<object>} input.metrics SampledMetric[]
 * @param {(url:string) => Promise<Map>} [input.scrape]
 * @param {() => Date} [input.now]
 * @param {(file:string, value:unknown) => void} [input.write]
 * @returns {{stop(): Promise<void>, data: object}}
 */
export function startMetricsSampler({
  targets,
  intervalSeconds,
  file,
  metrics,
  scrape = (url) => scrapeMetrics(url),
  now = () => new Date(),
  write = writeJson,
}) {
  const data = { schemaVersion: '1.0.0', intervalSeconds, targets, samples: [], warnings: [] };
  const warned = new Set();
  let timer = null;
  let running = null;
  let stopped = false;

  // One warning per (service, problem), not one per sample.
  const warnOnce = (message) => {
    if (warned.has(message)) return;
    warned.add(message);
    data.warnings.push(message);
  };

  const round = async () => {
    await Promise.all(
      targets.map(async ({ subject, url }) => {
        const at = toIsoWithOffset(now());
        try {
          const values = readSample(await scrape(url), metrics);
          for (const [key, value] of Object.entries(values)) {
            if (value === null) warnOnce(`${subject}: metric ${key} not found at ${url}`);
          }
          data.samples.push({ at, t: null, service: subject, metrics: values });
        } catch (error) {
          warnOnce(`${subject}: scrape of ${url} failed (${error.message})`);
          data.samples.push({
            at,
            t: null,
            service: subject,
            metrics: Object.fromEntries(metrics.map((m) => [m.key, null])),
          });
        }
      }),
    );
    write(file, data);
  };

  const loop = async () => {
    if (stopped) return;
    running = round();
    await running;
    if (!stopped) timer = setTimeout(loop, intervalSeconds * 1000);
  };
  loop();

  return {
    data,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Let a round in progress finish, then write a final copy.
      await running;
      write(file, data);
    },
  };
}
