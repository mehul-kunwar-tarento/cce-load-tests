/**
 * grafana.mjs — optional Grafana annotations that mark a run on every dashboard (plan §9.3).
 *
 * What:    Grafana "annotations" are markers on time-series panels. The runner adds them for every
 *          run (k6 or seeded Step SLA): run start/end, phase starts, send end, caught up, started
 *          breaking — tagged cce-performance, <runId>, <subject>, <testType>. Authentication:
 *          GRAFANA_API_TOKEN when set, else basic auth with monitoring.grafanaUser +
 *          GRAFANA_ADMIN_PASSWORD (the laptop stack's admin); neither → annotations are skipped with ONE
 *          warning. Annotation failures never fail a test.
 * How:     import { createAnnotator } from './clients/grafana.mjs';
 *          const annotator = createAnnotator({ environment, logger }); await annotator.annotate({ … });
 * Needs:   monitoring.enabled and monitoring.grafanaUrl in the environment; the token or password env var.
 * Outputs: POST <grafanaUrl>/api/annotations; nothing when disabled.
 */
import { postJson } from './http-json.mjs';

/**
 * Chooses the Grafana credentials (plan §3.1): token, else user + admin password, else null.
 * Why: secrets come only from environment variables (D15) and are never printed.
 * @param {object} environment
 * @param {Record<string,string|undefined>} [env]
 * @returns {{token:string}|{user:string, password:string}|null}
 */
export function resolveGrafanaAuth(environment, env = process.env) {
  if (env.GRAFANA_API_TOKEN) return { token: env.GRAFANA_API_TOKEN };
  const user = environment?.monitoring?.grafanaUser;
  if (user && env.GRAFANA_ADMIN_PASSWORD) return { user, password: env.GRAFANA_ADMIN_PASSWORD };
  return null;
}

/** HTTP Authorization header for the chosen credentials. */
function authorization(auth) {
  if ('token' in auth) return `Bearer ${auth.token}`;
  return `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString('base64')}`;
}

/**
 * Posts one annotation; never throws (a warning is returned instead).
 * Why: Grafana being down must not change a test result.
 * @param {{grafanaUrl:string, auth:object|null, time:number|string|Date, timeEnd?:number|string|Date,
 *          tags:string[], text:string, fetchFn?: typeof fetch}} input
 * @returns {Promise<string|null>} a warning, or null when posted (or skipped because auth is null)
 */
export async function postAnnotation({ grafanaUrl, auth, time, timeEnd, tags, text, fetchFn }) {
  if (!auth || !grafanaUrl) return null;
  const body = { time: new Date(time).getTime(), tags, text };
  if (timeEnd !== undefined && timeEnd !== null) body.timeEnd = new Date(timeEnd).getTime();
  try {
    const { status } = await postJson(`${grafanaUrl.replace(/\/$/, '')}/api/annotations`, body, {
      headers: { authorization: authorization(auth) },
      timeoutMs: 3000,
      fetchFn,
    });
    return status >= 200 && status < 300 ? null : `Grafana annotation not saved: HTTP ${status}`;
  } catch (error) {
    return `Grafana annotation not saved: ${error.message}`;
  }
}

/**
 * An annotator bound to one environment.
 * Why: commands call annotate() at each milestone without caring whether Grafana is configured; when it
 * is not, the first call logs one warning and every call is a no-op.
 * @param {{environment:object, logger?:{warn(m:string):void}, env?:Record<string,string|undefined>,
 *          fetchFn?: typeof fetch, baseTags?: string[]}} input
 * @returns {{enabled:boolean, authKind:'token'|'basic'|null, annotate(a:{time:any, timeEnd?:any, tags?:string[], text:string}):Promise<void>}}
 */
export function createAnnotator({
  environment,
  logger,
  env = process.env,
  fetchFn,
  baseTags = [],
}) {
  const monitoring = environment?.monitoring ?? {};
  const auth = monitoring.enabled ? resolveGrafanaAuth(environment, env) : null;
  let warned = false;
  const warnOnce = (message) => {
    if (warned) return;
    warned = true;
    logger?.warn?.(message);
  };
  return {
    enabled: Boolean(auth && monitoring.grafanaUrl),
    authKind: auth ? ('token' in auth ? 'token' : 'basic') : null,
    async annotate({ time, timeEnd, tags = [], text }) {
      if (!monitoring.enabled) return;
      if (!auth) {
        warnOnce(
          'Grafana annotations skipped: set GRAFANA_API_TOKEN, or GRAFANA_ADMIN_PASSWORD for ' +
            `user ${monitoring.grafanaUser ?? '(monitoring.grafanaUser)'}`,
        );
        return;
      }
      const warning = await postAnnotation({
        grafanaUrl: monitoring.grafanaUrl,
        auth,
        time,
        timeEnd,
        tags: ['cce-performance', ...baseTags, ...tags],
        text,
        fetchFn,
      });
      if (warning) warnOnce(warning);
    },
  };
}
