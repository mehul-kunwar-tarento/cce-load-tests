/**
 * service-metrics.mjs — preflight check `service-metrics.<subject>`: /actuator/prometheus answers with the key metric
 *
 * What:    The watchers, the sampler and the Grafana dashboards read these metrics; if the endpoint is off or
 *          the service never registered its key counter, the run would measure nothing.
 *          Key metrics: collector cce_collector_events_received_total, matcher cce_events_processed_total,
 *          Step SLA cce_sla_transitions_due.
 * How:     forSubject('matcher'); expanded by checks/index.mjs.
 * Needs:   serviceConfig(...).baseUrl/metricsPath, ctx.clients.scrapeUrl(url) → parsed Prometheus text (Map).
 * Outputs: { status, detail, data: { url, metric, value } }
 */
import { serviceConfig } from '../../core/environment.mjs';
import {
  DISPLAY_NAMES,
  SERVICE_SUBJECTS,
  fail,
  memo,
  pass,
  sumSeries,
  testsSubject,
} from '../check-helpers.mjs';

/** The metric that proves each service's own instrumentation is there. */
export const KEY_METRICS = {
  collector: 'cce_collector_events_received_total',
  matcher: 'cce_events_processed_total',
  'step-sla': 'cce_sla_transitions_due',
};

/** Subjects whose metrics endpoint is checked (requires.services, never protocol). */
export function metricsSubjects(ctx) {
  if (ctx.stackCheck) return SERVICE_SUBJECTS.filter((s) => serviceConfig(ctx.environment, s));
  const wanted = new Set(ctx.subjects.flatMap((s) => s.requires?.services ?? [s.subject]));
  return SERVICE_SUBJECTS.filter((s) => wanted.has(s));
}

/** Scrape once per run and remember (the scheduler check takes its own two later scrapes). */
export function readMetrics(ctx, subject) {
  return memo(ctx, `metrics:${subject}`, async () => {
    const service = serviceConfig(ctx.environment, subject);
    const url = `${service.baseUrl}${service.metricsPath ?? '/actuator/prometheus'}`;
    try {
      return { url, parsed: await ctx.clients.scrapeUrl(url) };
    } catch (error) {
      return { url, parsed: null, error: error.message };
    }
  });
}

/** Build the check for one subject. */
export function forSubject(subject) {
  return {
    id: `service-metrics.${subject}`,
    title: `${DISPLAY_NAMES[subject] ?? subject} /actuator/prometheus has ${KEY_METRICS[subject]}`,
    appliesTo: (ctx) => Boolean(serviceConfig(ctx.environment, subject)),
    /** Matcher and Step SLA are measured through these metrics; the collector mostly through k6. */
    severity: (ctx) =>
      !ctx.stackCheck && testsSubject(ctx, subject) && subject !== 'collector'
        ? 'required'
        : 'warning',
    async run(ctx) {
      const metric = KEY_METRICS[subject];
      const { url, parsed, error } = await readMetrics(ctx, subject);
      if (error)
        return fail(`metrics endpoint not answering at ${url} (${error})`, { url, metric });
      const value = sumSeries(parsed, metric);
      if (value === null) return fail(`${metric} missing at ${url}`, { url, metric, value });
      return pass(`${metric} = ${value}`, { url, metric, value });
    },
  };
}
