/**
 * collector-scenario.js — what ONE iteration of every collector test does: post one new event.
 *
 * What:    In an arrival-rate (open model) test, k6 starts a fixed number of iterations per second whether
 *          or not the collector keeps up; each iteration is one event. This file builds that iteration once
 *          for the four collector tests (smoke, load, stress, breakpoint): tag it (phase, staircase level,
 *          report window), make a new patient and event id (LOADTEST-<runId>-col-<phaseIndex>-<n>, ≤ 50
 *          characters), fill the dataset's FHIR template for EVENT_ACTION_ID, wrap it in the CloudEvent the
 *          collector expects (lowercase fields, facilityid in the body), POST it to /v1/events and check
 *          that the answer is 202 with data.status "accepted". Only then is the event counted as accepted.
 * How:     Imported by tests/collector-<type>.test.js:
 *            export default createCollectorIteration(context);
 *          Never run on its own (it has no options).
 * Needs:   The run context (environment.services.collector.baseUrl, dataset, settings EVENT_SOURCE /
 *          FACILITY_ID / EVENT_ACTION_ID, phasePlan, runId, idCode 'col'); k6 (k6/execution).
 * Outputs: One HTTP request per iteration (k6 http_req_* metrics with name tag "POST /v1/events"), checks
 *          "status is 202" and "event accepted", counters events_sent / events_accepted.
 */
import exec from 'k6/execution';
import {
  buildCloudEvent,
  buildCorrelationId,
  buildEventId,
  buildFhirResource,
  buildPatientId,
  checkResponse,
  eventDefaults,
  jsonFieldEquals,
  postJson,
  recordSend,
  statusIs,
  tagIteration,
} from './shared-lib.js';

/** The collector's ingestion endpoint (release-2.0.0): structured CloudEvent, JSON, no auth. */
export const EVENTS_PATH = '/v1/events';

/** Name tag of every request: one metric series for the endpoint, whatever the URL (no label explosion). */
export const REQUEST_NAME = 'POST /v1/events';

/** Single-event tests send step 1 of a journey (EVENT_MODE=single; journeys are later work). */
const STEP_NUMBER = 1;

/** The two checks of every answer; both must pass for the event to count as accepted. */
const CHECKS = {
  // 202 = stored and published to Kafka; 200 would be "duplicate", 4xx/5xx a rejection or error.
  'status is 202': statusIs(202),
  // The body says what happened: only "accepted" is new work for CCE ("duplicate" is not).
  'event accepted': jsonFieldEquals('data.status', 'accepted'),
};

/**
 * Builds the iteration function of a collector test from its run context.
 * Why: the URL, source, facility and action id are fixed for the whole run, so they are worked out once
 * here (init context) instead of in every iteration.
 * @param {object} context run context (plan §3.5), from getRunContext()
 * @returns {() => void} the function k6 runs for every iteration (the test file's default export)
 */
export function createCollectorIteration(context) {
  const collector = context.environment && context.environment.services.collector;
  if (!collector || !collector.baseUrl) {
    throw new Error(
      `Environment ${context.environment && context.environment.name} has no services.collector.baseUrl`,
    );
  }
  // Direct service URL (never the gateway: it rate-limits /v1/events, plan §3.1).
  const url = `${collector.baseUrl.replace(/\/$/, '')}${EVENTS_PATH}`;
  // EVENT_SOURCE / FACILITY_ID / EVENT_ACTION_ID when set, else the dataset's defaults.
  const { source, facilityId, actionId } = eventDefaults({
    dataset: context.dataset,
    settings: context.settings,
  });

  /** One iteration = one new event (why a function: k6 calls it at the configured arrival rate). */
  return function sendCollectorEvent() {
    // First: tag phase / level / window, so every metric of this iteration lands in the right bucket.
    const { phaseIndex } = tagIteration(context);
    if (phaseIndex < 0) return; // not a load scenario (none exists today): send nothing
    // iterationInTest is 0, 1, 2 … within this scenario (= phase), so ids are enumerable from the phase
    // plan and the data checks can look them up by index instead of scanning (plan §2.3, §6.8).
    const n = exec.scenario.iterationInTest;
    const patientId = buildPatientId({
      runId: context.runId,
      idCode: context.idCode,
      phaseIndex,
      n,
    });
    const eventId = buildEventId(patientId, STEP_NUMBER); // throws if longer than 50 characters
    // Dated "now", so the protocol's deadlines are in the future and Step SLA records no misses.
    const time = new Date().toISOString();
    const resource = buildFhirResource({
      dataset: context.dataset,
      actionId,
      patientId,
      eventId,
      facilityId,
      time,
    });
    const cloudEvent = buildCloudEvent({
      dataset: context.dataset,
      resource,
      patientId,
      eventId,
      facilityId,
      correlationId: buildCorrelationId(context.runId, n),
      source,
      time,
    });
    const response = postJson(url, cloudEvent, { name: REQUEST_NAME });
    // accepted = both checks passed; recordSend keeps events_sent and events_accepted consistent.
    recordSend(checkResponse(response, CHECKS));
  };
}
