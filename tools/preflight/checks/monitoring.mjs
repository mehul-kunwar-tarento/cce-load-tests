/**
 * monitoring.mjs — preflight check `monitoring`: Prometheus, its remote-write receiver and Grafana answer
 *
 * What:    k6 pushes its metrics to Prometheus by remote write and the run is annotated in Grafana. Checks
 *          Prometheus /-/ready, the remote-write URL (an empty POST must get 400 or 204: anything but 404/5xx
 *          means the receiver is on), Grafana /api/health and that annotation credentials exist
 *          (GRAFANA_API_TOKEN, or GRAFANA_ADMIN_PASSWORD; only presence is checked, never printed).
 *          Warning by default; required with MONITORING_REQUIRED=true.
 * How:     Listed in checks/index.mjs.
 * Needs:   environment.monitoring, ctx.clients.http.request, ctx.env.
 * Outputs: { status, detail, data: { prometheusReady, remoteWriteStatus, grafanaStatus, annotationAuth } }
 */
import { fail, pass, warn } from '../check-helpers.mjs';

/** Why: a dead endpoint must be a result, not an exception that hides the other two answers. */
async function statusOf(ctx, method, url, body) {
  try {
    return (await ctx.clients.http.request({ method, url, body })).status;
  } catch {
    return null;
  }
}

export default {
  id: 'monitoring',
  title: 'Prometheus ready, remote write accepted, Grafana healthy, annotation auth available',
  appliesTo: (ctx) => ctx.environment?.monitoring?.enabled === true,
  severity: (ctx) => (ctx.settings.MONITORING_REQUIRED ? 'required' : 'warning'),
  async run(ctx) {
    const m = ctx.environment.monitoring;
    const prometheusReady = await statusOf(ctx, 'GET', `${m.prometheusUrl}/-/ready`);
    const remoteWriteStatus = await statusOf(ctx, 'POST', m.remoteWriteUrl, {});
    const grafanaStatus = m.grafanaUrl
      ? await statusOf(ctx, 'GET', `${m.grafanaUrl}/api/health`)
      : null;
    const annotationAuth = ctx.env?.GRAFANA_API_TOKEN
      ? 'token'
      : ctx.env?.GRAFANA_ADMIN_PASSWORD
        ? 'basic'
        : null;
    const data = { prometheusReady, remoteWriteStatus, grafanaStatus, annotationAuth };
    const problems = [];
    if (prometheusReady !== 200)
      problems.push(`Prometheus not ready (${prometheusReady ?? 'no answer'})`);
    if (![200, 204, 400].includes(remoteWriteStatus)) {
      problems.push(
        remoteWriteStatus === 404
          ? 'remote-write receiver disabled (404)'
          : `remote write ${remoteWriteStatus ?? 'no answer'}`,
      );
    }
    if (m.grafanaUrl && grafanaStatus !== 200)
      problems.push(`Grafana ${grafanaStatus ?? 'no answer'}`);
    if (problems.length) return fail(problems.join('; '), data);
    if (!annotationAuth)
      return warn(
        'reachable, but no GRAFANA_API_TOKEN / GRAFANA_ADMIN_PASSWORD: runs will not be annotated',
        data,
      );
    return pass(`Prometheus, remote write and Grafana OK (annotations: ${annotationAuth})`, data);
  },
};
