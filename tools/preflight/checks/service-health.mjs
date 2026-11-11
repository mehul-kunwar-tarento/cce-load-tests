/**
 * service-health.mjs — preflight check `service-health.<subject>`: GET /actuator/health once, expect UP
 *
 * What:    A crash-looping service can look "up" as a container (lesson 11): its own health endpoint is the
 *          truth. Called ONCE per run and memoised, because the collector's health indicator opens a Kafka
 *          AdminClient on every call (do not poll it).
 * How:     forSubject('matcher') returns the check for one service; checks/index.mjs expands it for
 *          healthSubjects(ctx) (the run's service modules' requires.services, adaptors included).
 * Needs:   serviceConfig(environment, subject).baseUrl/healthPath (services.<key> or adaptors.<key>),
 *          ctx.clients.http.request.
 * Outputs: { status, detail, data: { url, health, downComponents } }
 */
import { serviceConfig } from '../../core/environment.mjs';
import { DISPLAY_NAMES, fail, memo, pass } from '../check-helpers.mjs';

/** The CCE services in flow order; why: checks are printed in this order, any other subject after them. */
const FLOW_ORDER = ['collector', 'matcher', 'step-sla', 'protocol'];

/** Environment JSON key → subject spelling (services.stepSla is the step-sla subject). */
const KEY_TO_SUBJECT = { stepSla: 'step-sla' };

/**
 * Subjects whose health is checked in this run (plan §7.1: requires.services + protocol when a set is used).
 * Why: derived from the discovered service modules' `requires.services`, not from a fixed list, so a later
 *      adaptor module (whose address is in `services.<key>` or `adaptors.<key>`) gets the R15 health check
 *      without a change here. A stack check (no subject) covers every service and adaptor configured.
 */
export function healthSubjects(ctx) {
  let wanted;
  if (ctx.stackCheck) {
    const keys = [
      ...Object.keys(ctx.environment?.services ?? {}),
      ...Object.keys(ctx.environment?.adaptors ?? {}),
    ];
    wanted = new Set(keys.map((key) => KEY_TO_SUBJECT[key] ?? key));
  } else {
    wanted = new Set(ctx.subjects.flatMap((s) => s.requires?.services ?? [s.subject]));
    if (ctx.planDefinitionSetName || ctx.subjects.some((s) => s.requires?.protocol))
      wanted.add('protocol');
  }
  // A subject with no address in the environment is still listed; its check's appliesTo() skips it.
  return [
    ...FLOW_ORDER.filter((s) => wanted.has(s)),
    ...[...wanted].filter((s) => !FLOW_ORDER.includes(s)),
  ];
}

/**
 * Read one service's health, memoised per run.
 * Why: also used by other code paths that need "is it up" without a second call.
 */
export function readHealth(ctx, subject) {
  return memo(ctx, `health:${subject}`, async () => {
    const service = serviceConfig(ctx.environment, subject);
    const url = `${service.baseUrl}${service.healthPath ?? '/actuator/health'}`;
    try {
      const { status, body } = await ctx.clients.http.request({ method: 'GET', url });
      return { url, httpStatus: status, body };
    } catch (error) {
      return { url, httpStatus: null, body: null, error: error.message };
    }
  });
}

/** Build the check for one subject. */
export function forSubject(subject) {
  return {
    id: `service-health.${subject}`,
    title: `${DISPLAY_NAMES[subject] ?? subject} /actuator/health is UP`,
    appliesTo: (ctx) => Boolean(serviceConfig(ctx.environment, subject)),
    severity: () => 'required',
    async run(ctx) {
      const { url, httpStatus, body, error } = await readHealth(ctx, subject);
      if (error) return fail(`not answering at ${url} (${error})`, { url });
      const health = body?.status ?? null;
      // Spring lists sub-checks (db, kafka, diskSpace…); naming the DOWN ones points at the cause.
      const downComponents = Object.entries(body?.components ?? {})
        .filter(([, c]) => c?.status && c.status !== 'UP')
        .map(([name, c]) => `${name}=${c.status}`);
      const data = { url, health, httpStatus, downComponents };
      if (health === 'UP') return pass('UP', data);
      return fail(
        `${health ?? `HTTP ${httpStatus}`}${downComponents.length ? ` (${downComponents.join(', ')})` : ''}`,
        data,
      );
    },
  };
}
