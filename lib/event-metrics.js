/**
 * event-metrics.js — the two counters every test keeps: events sent and events accepted (K6)
 *
 * What:    k6 counts requests and iterations, but "events" is our unit (an HTTP request to the collector
 *          or a Kafka message to the matcher). Two counters make the summary say how many events were
 *          sent and how many the service accepted, per scenario (phase). Their names are part of the
 *          result contract: the result builder reads events_sent and events_accepted{scenario:measure}.
 * How:     import { recordSend } from '../../lib/event-metrics.js';
 *          recordSend(ok);   // after every send attempt
 * Needs:   k6 (k6/metrics).
 * Outputs: k6 counters `events_sent`, `events_accepted` (also exported to Prometheus as k6_events_*).
 */

import { Counter } from 'k6/metrics';

/** +1 after every send attempt (HTTP request or Kafka produce), accepted or not. */
export const eventsSent = new Counter('events_sent');

/** +1 when the service accepted the event (HTTP: all checks passed; Kafka: produce did not throw). */
export const eventsAccepted = new Counter('events_accepted');

/**
 * Records one send attempt.
 * Why: one call keeps the two counters consistent. A rejected event adds 0 to events_accepted so the
 * per-scenario sub-metric always exists in the summary (count 0 instead of a missing key).
 * @param {boolean} accepted
 */
export function recordSend(accepted) {
  eventsSent.add(1);
  eventsAccepted.add(accepted ? 1 : 0);
}
