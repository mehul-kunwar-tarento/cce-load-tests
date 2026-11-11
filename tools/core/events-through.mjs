/**
 * events-through.mjs — how many events (or alarms) really "went through" a service, and at what rate.
 *
 * What:    The team lead's first review point (R1) asks how much load went through in the configured
 *          interval. What k6 SENT is not what the service TOOK, so "went through" is defined per kind of
 *          test and every report uses this one definition:
 *            - http    (collector): events ACCEPTED by the service (HTTP 2xx) in the measured interval;
 *                      over the measured interval.
 *            - kafka   (matcher):   events PROCESSED by the service (its own counter, from the watcher),
 *                      warm-up events taken off (sent at a low rate, so processed during warm-up), counted
 *                      from the start of the measured interval until it caught up or the catch-up wait
 *                      ended — never more than were sent in the measured interval.
 *            - seeded  (Step SLA):  alarms HANDLED by the service (the database check), over the ring
 *                      interval plus the catch-up (a storm rings at once: catch-up only).
 *            - fallback: what was sent ('sent' basis) when the service's own count is not available —
 *                      the report then says so instead of presenting it as "went through".
 *          averageRate = eventsThrough ÷ throughSeconds, so the rate is also what the service took.
 * How:     import { decideThrough, throughOf } from './events-through.mjs';
 *          result-builder.mjs writes load.eventsThrough/throughBasis/throughSeconds/averageRate with
 *          decideThrough; reports call throughOf(result), which also works for result.json files written
 *          before these fields existed (it infers the kind from the result).
 * Needs:   Nothing (pure functions on the result's load and breaking blocks).
 * Outputs: { eventsThrough, throughBasis, throughSeconds, averageRate }.
 */

/** The bases of "went through", in the words the reports use. */
export const THROUGH_BASES = Object.freeze(['accepted', 'processed', 'handled', 'sent']);

/** Why: a plain number check that also rejects NaN and Infinity. */
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Seconds the service had after sending stopped: until it caught up, or until the watch gave up.
 * Why: processed/handled counts include the catch-up, so their rate must be over the same time.
 * @param {object} breaking result.breaking
 * @param {number|null} [fallbackSeconds] e.g. the catch-up phase length when caughtUp is unknown
 */
function catchUpSecondsOf(breaking, fallbackSeconds = null) {
  if (breaking?.caughtUp === true && isNumber(breaking.catchUpSeconds))
    return breaking.catchUpSeconds;
  if (breaking?.caughtUp === false && isNumber(breaking.gaveUpAfterSeconds))
    return breaking.gaveUpAfterSeconds;
  return isNumber(fallbackSeconds) ? Math.max(0, fallbackSeconds) : 0;
}

/**
 * Decides "went through" for one run.
 * @param {object} input
 * @param {object} input.load the load block (k6 counters, watcher/module figures already overlaid)
 * @param {object} [input.breaking] the breaking block (catch-up facts)
 * @param {'http'|'kafka'|'seeded'|null} input.transport how the load reached the service
 * @param {number|null} [input.catchUpFallbackSeconds] catch-up length when breaking does not say
 * @returns {{eventsThrough:number|null, throughBasis:string|null, throughSeconds:number|null, averageRate:number|null}}
 */
export function decideThrough({
  load = {},
  breaking = {},
  transport,
  catchUpFallbackSeconds = null,
}) {
  const measuredSeconds = isNumber(load.measuredSeconds) ? load.measuredSeconds : null;
  const sentMeasured = isNumber(load.measuredEventsSent)
    ? load.measuredEventsSent
    : isNumber(load.eventsSent)
      ? load.eventsSent
      : null;
  let eventsThrough = null;
  let throughBasis = null;
  let throughSeconds = null;

  if (transport === 'http' && isNumber(load.measuredEventsAccepted)) {
    eventsThrough = load.measuredEventsAccepted;
    throughBasis = 'accepted';
    throughSeconds = measuredSeconds;
  } else if (transport === 'kafka' && isNumber(load.eventsProcessed)) {
    // The processed counter covers the whole watch, warm-up included: take the warm-up events off.
    const warmUp =
      isNumber(load.eventsSent) && isNumber(load.measuredEventsSent)
        ? Math.max(0, load.eventsSent - load.measuredEventsSent)
        : 0;
    eventsThrough = Math.max(0, load.eventsProcessed - warmUp);
    // A shared counter can include other traffic: never more test events than were sent.
    if (isNumber(sentMeasured)) eventsThrough = Math.min(eventsThrough, sentMeasured);
    throughBasis = 'processed';
    throughSeconds =
      measuredSeconds === null
        ? null
        : measuredSeconds + catchUpSecondsOf(breaking, catchUpFallbackSeconds);
  } else if (transport === 'seeded' && isNumber(load.eventsProcessed)) {
    eventsThrough = load.eventsProcessed;
    throughBasis = 'handled';
    throughSeconds =
      measuredSeconds === null
        ? null
        : measuredSeconds + catchUpSecondsOf(breaking, catchUpFallbackSeconds);
  } else if (isNumber(sentMeasured)) {
    // The service's own count is missing (no summary, no watcher readings): say "sent", never "took".
    eventsThrough = sentMeasured;
    throughBasis = 'sent';
    throughSeconds = measuredSeconds;
  }
  const averageRate =
    isNumber(eventsThrough) && isNumber(throughSeconds) && throughSeconds > 0
      ? eventsThrough / throughSeconds
      : null;
  return { eventsThrough, throughBasis, throughSeconds, averageRate };
}

/**
 * How the load reached the service, read from a result.json.
 * Why: result.json files written before load.throughBasis existed still need the right "went through".
 * @param {object} result
 * @returns {'http'|'kafka'|'seeded'|null}
 */
export function transportOfResult(result) {
  if (result?.load?.unit === 'alarms' || result?.timing?.source === 'seed') return 'seeded';
  if (result?.latency) return 'http'; // latency comes from k6 http_req_duration only
  if (isNumber(result?.load?.eventsSent) && result?.timing?.source !== 'seed') return 'kafka';
  return null;
}

/**
 * "Went through" of a result: the saved fields when present, else decided from the result (older files).
 * @param {object} result
 * @returns {{eventsThrough:number|null, throughBasis:string|null, throughSeconds:number|null, averageRate:number|null}}
 */
export function throughOf(result) {
  const load = result?.load ?? {};
  if (load.throughBasis !== undefined && load.eventsThrough !== undefined) {
    return {
      eventsThrough: load.eventsThrough,
      throughBasis: load.throughBasis,
      throughSeconds: load.throughSeconds ?? null,
      averageRate: load.averageRate ?? null,
    };
  }
  const catchUp = (result?.phases ?? []).find((phase) => phase.name === 'catch-up');
  const catchUpSeconds =
    catchUp?.startedAt && catchUp?.endedAt
      ? (new Date(catchUp.endedAt).getTime() - new Date(catchUp.startedAt).getTime()) / 1000
      : null;
  return decideThrough({
    load,
    breaking: result?.breaking ?? {},
    transport: transportOfResult(result),
    catchUpFallbackSeconds: catchUpSeconds,
  });
}

/**
 * The basis in words, for "N events went through (<words>)".
 * @param {string|null} basis
 * @param {string} [unit] 'events' or 'alarms'
 */
export function throughWords(basis, unit = 'events') {
  switch (basis) {
    case 'accepted':
      return 'accepted by the service, HTTP 2xx';
    case 'processed':
      return 'processed by the service';
    case 'handled':
      return 'handled by the service';
    case 'sent':
      return unit === 'alarms'
        ? "seeded; the service's handled count is not available"
        : "sent by k6; the service's own count is not available";
    default:
      return 'basis unknown';
  }
}
