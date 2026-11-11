/**
 * step-sla-scheduler.mjs — preflight check `step-sla-scheduler`: the Step SLA evaluator is cycling
 *
 * What:    Step SLA's readiness probe does not cover its scheduler (open question 10). The counter
 *          cce_sla_evaluator_cycles_total must increase between two scrapes taken one poll interval + 2 s apart.
 * How:     Listed in checks/index.mjs.
 * Needs:   services.stepSla.baseUrl/metricsPath/pollIntervalSeconds, ctx.clients.scrapeUrl(url), ctx.clients.sleep.
 * Outputs: { status, detail, data: { first, second, waitedSeconds } }
 */
import { serviceConfig } from '../../core/environment.mjs';
import { fail, pass, sumSeries, testsSubject } from '../check-helpers.mjs';

export const CYCLES_METRIC = 'cce_sla_evaluator_cycles_total';

export default {
  id: 'step-sla-scheduler',
  title: 'Step SLA evaluator cycles increase',
  appliesTo: (ctx) =>
    Boolean(serviceConfig(ctx.environment, 'step-sla')) &&
    (ctx.stackCheck || testsSubject(ctx, 'step-sla')),
  severity: (ctx) => (testsSubject(ctx, 'step-sla') ? 'required' : 'warning'),
  async run(ctx) {
    const service = serviceConfig(ctx.environment, 'step-sla');
    const url = `${service.baseUrl}${service.metricsPath ?? '/actuator/prometheus'}`;
    const waitedSeconds = Number(service.pollIntervalSeconds ?? 5) + 2;
    const first = sumSeries(await ctx.clients.scrapeUrl(url), CYCLES_METRIC);
    if (first === null)
      return fail(`${CYCLES_METRIC} missing at ${url}`, { first, second: null, waitedSeconds: 0 });
    await ctx.clients.sleep(waitedSeconds * 1000);
    const second = sumSeries(await ctx.clients.scrapeUrl(url), CYCLES_METRIC);
    const data = { first, second, waitedSeconds };
    if (second !== null && second > first)
      return pass(`${second - first} cycle(s) in ${waitedSeconds} s`, data);
    return fail(`no evaluator cycle in ${waitedSeconds} s (scheduler stopped?)`, data);
  },
};
