/**
 * test-data.js — test-data ids and the events the tests send: FHIR resources inside CloudEvents (PURE)
 *
 * What:    Every event a test sends must be (1) recognisable as test data, so cleanup can find and
 *          delete exactly one run's rows, and (2) shaped like what a real EMR sends. Ids follow
 *          plan §2.3: patient `LOADTEST-<runId>-<idCode>-<phaseIndex>-<n>`, event `<patientId>-<step>`
 *          (at most 50 characters: the collector's limit). The FHIR resource comes from a dataset
 *          template (test-data/datasets/<name>/dataset.json) with {{placeholders}} filled in, and is
 *          wrapped in a CloudEvent (the envelope CCE's collector and matcher read).
 * How:     import { buildIterationEvent } from '../lib/test-data.js';
 *          const { patientId, cloudEvent } = buildIterationEvent({ context, phaseIndex, n });
 * Needs:   A dataset object (run context `dataset`, plan §3.5) and the run id; nothing else.
 * Outputs: Id strings, filled templates, FHIR resources and CloudEvent objects.
 */

/** The collector rejects CloudEvent ids longer than this (CloudEventValidator MAX_ID_LENGTH). */
export const MAX_CLOUD_EVENT_ID_LENGTH = 50;

/** Every piece of test data starts with this word, so it can never be mistaken for real data. */
const TEST_DATA_WORD = 'LOADTEST';

/** Placeholders a template may use (plan §4.6); anything else is a typo and is refused. */
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/**
 * Prefix of every id a run creates, e.g. "LOADTEST-20261105-142233-".
 * Why: cleanup and data checks select one run's rows by it (plan §2.3, §7.2).
 * @param {string} runId
 * @returns {string}
 */
export function testDataPrefix(runId) {
  requireText(runId, 'runId');
  return `${TEST_DATA_WORD}-${runId}-`;
}

/**
 * Patient id of one iteration: LOADTEST-<runId>-<idCode>-<phaseIndex>-<n>.
 * Why: n is k6's iteration number within the phase, so ids are enumerable from the phase plan and
 * data checks can look them up by index instead of scanning with LIKE (plan §6.8); phaseIndex keeps
 * warm-up and measure patients apart.
 * @param {{runId:string, idCode:string, phaseIndex:number, n:number}} parts idCode e.g. 'col', 'mat', 'sla'
 * @returns {string}
 */
export function buildPatientId({ runId, idCode, phaseIndex, n }) {
  requireText(idCode, 'idCode');
  // A hyphen inside the id code would break the "selector ends with the id code" rule of §2.3.
  if (idCode.includes('-')) throw new Error(`idCode "${idCode}" must not contain a hyphen`);
  requireCount(phaseIndex, 'phaseIndex');
  requireCount(n, 'n');
  return `${testDataPrefix(runId)}${idCode}-${phaseIndex}-${n}`;
}

/**
 * Event id: <patientId>-<stepNumber> (step = 1-based position in the journey; 1 for single events).
 * Why: unique per event (the services skip a repeated id + source as a duplicate) and readable back
 * from the stored row. Throws when longer than the collector accepts, so the problem shows before a run.
 * @param {string} patientId
 * @param {number} stepNumber
 * @returns {string}
 */
export function buildEventId(patientId, stepNumber) {
  requireText(patientId, 'patientId');
  if (!Number.isInteger(stepNumber) || stepNumber < 1) {
    throw new Error(`stepNumber must be a whole number ≥ 1, got ${JSON.stringify(stepNumber)}`);
  }
  const eventId = `${patientId}-${stepNumber}`;
  if (eventId.length > MAX_CLOUD_EVENT_ID_LENGTH) {
    throw new Error(
      `Event id "${eventId}" is ${eventId.length} characters; the collector accepts at most ` +
        `${MAX_CLOUD_EVENT_ID_LENGTH}. Use a shorter RUN_ID.`,
    );
  }
  return eventId;
}

/**
 * Correlation id of an event: LOADTEST-<runId>-corr-<n> (plan §2.3).
 * Why: lets the services' logs be followed per event and still marks the value as test data.
 * @param {string} runId
 * @param {number} n
 * @returns {string}
 */
export function buildCorrelationId(runId, n) {
  requireCount(n, 'n');
  return `${testDataPrefix(runId)}corr-${n}`;
}

/**
 * Fills a template: deep copy, "{{name}}" inside any string replaced by values[name], and every
 * "$comment" key (at any level) dropped.
 * Why: dataset files explain themselves with "$comment" keys, which must never reach a CCE service;
 * the template itself must stay unchanged for the next iteration.
 * @param {unknown} template a JSON value (object, array, string, number…)
 * @param {Record<string, string|number>} values e.g. { patientId, eventId, facilityId, time, endTime }
 * @returns {any} the filled copy
 */
export function fillTemplate(template, values) {
  if (Array.isArray(template)) return template.map((item) => fillTemplate(item, values));
  if (template !== null && typeof template === 'object') {
    const copy = {};
    for (const [key, value] of Object.entries(template)) {
      if (key === '$comment') continue; // documentation only
      copy[key] = fillTemplate(value, values);
    }
    return copy;
  }
  if (typeof template === 'string') {
    return template.replace(PLACEHOLDER, (whole, name) => {
      if (values[name] === undefined || values[name] === null) {
        throw new Error(
          `Template placeholder ${whole} has no value (known: ${Object.keys(values).join(', ')})`,
        );
      }
      return String(values[name]);
    });
  }
  return template; // numbers, booleans and null are copied as they are
}

/**
 * The FHIR resource that completes one action (step) of the plan definition, from the dataset.
 * Why: the dataset decides what an EMR sends for each action id; tests only choose the action.
 * @param {{dataset:object, actionId:string, patientId:string, eventId:string, facilityId:string,
 *          time:string, endTime?:string}} input time = ISO clinical time (the matcher reads it)
 * @returns {object} e.g. an Encounter or Observation
 */
export function buildFhirResource({
  dataset,
  actionId,
  patientId,
  eventId,
  facilityId,
  time,
  endTime = time,
}) {
  const template = dataset && dataset.eventTemplates ? dataset.eventTemplates[actionId] : undefined;
  if (!template) {
    const known =
      dataset && dataset.eventTemplates ? Object.keys(dataset.eventTemplates).join(', ') : 'none';
    throw new Error(
      `Dataset "${dataset && dataset.name}" has no event template for action "${actionId}" (has: ${known})`,
    );
  }
  return fillTemplate(template, { patientId, eventId, facilityId, time, endTime });
}

/**
 * Wraps a FHIR resource in the CloudEvent CCE expects (the envelope the collector stores and publishes).
 * Why: the collector (HTTP) and the matcher (Kafka) both read this envelope; source and facility come
 * from the dataset or the settings, never from code.
 * @param {{dataset?:object, resource:object, patientId:string, eventId:string, facilityId?:string,
 *          correlationId?:string|null, source?:string, time:string}} input
 * @returns {{specversion:string, id:string, source:string, type:string, subject:string, time:string,
 *            facilityid:string, correlationid?:string, datacontenttype:string, data:object}}
 */
export function buildCloudEvent({
  dataset,
  resource,
  patientId,
  eventId,
  facilityId,
  correlationId,
  source,
  time,
}) {
  const eventSource = source || (dataset && dataset.source);
  const facility = facilityId || (dataset && dataset.facilityId);
  requireText(eventSource, 'source (dataset "source" or setting EVENT_SOURCE)');
  requireText(facility, 'facilityId (dataset "facilityId" or setting FACILITY_ID)');
  if (eventId.length > MAX_CLOUD_EVENT_ID_LENGTH) {
    throw new Error(`Event id "${eventId}" is longer than ${MAX_CLOUD_EVENT_ID_LENGTH} characters`);
  }
  const event = {
    specversion: '1.0',
    id: eventId,
    source: eventSource,
    type: resource.resourceType, // CCE routes on the FHIR resource type
    subject: patientId, // the matcher enrols this patient
    time,
    facilityid: facility,
  };
  // Without a correlation id the collector generates one; only send ours when given.
  if (correlationId) event.correlationid = correlationId;
  event.datacontenttype = 'application/fhir+json';
  event.data = resource;
  return event;
}

/**
 * Source, facility and action id in force for a run: the setting when set, else the dataset's default.
 * Why: EVENT_SOURCE, FACILITY_ID and EVENT_ACTION_ID are overridable per run (plan §3.2).
 * @param {{dataset:object, settings:Record<string, unknown>}} input
 * @returns {{source:string, facilityId:string, actionId:string}}
 */
export function eventDefaults({ dataset, settings }) {
  const pick = (name, fallback) => (settings && settings[name] ? settings[name] : fallback);
  return {
    source: pick('EVENT_SOURCE', dataset.source),
    facilityId: pick('FACILITY_ID', dataset.facilityId),
    actionId: pick('EVENT_ACTION_ID', dataset.defaultActionId),
  };
}

/**
 * Everything one k6 iteration needs to send one event (EVENT_MODE=single).
 * Why: collector and matcher tests build the same event the same way; only the transport differs.
 * @param {{context:object, phaseIndex:number, n:number, stepNumber?:number, now?:Date}} input
 *   context = run context (plan §3.5: runId, idCode, settings, dataset)
 * @returns {{patientId:string, eventId:string, cloudEvent:object}}
 */
export function buildIterationEvent({ context, phaseIndex, n, stepNumber = 1, now = new Date() }) {
  const { dataset, settings, runId, idCode } = context;
  const { source, facilityId, actionId } = eventDefaults({ dataset, settings });
  const patientId = buildPatientId({ runId, idCode, phaseIndex, n });
  const eventId = buildEventId(patientId, stepNumber);
  // Dated "now", so the protocol's deadlines are in the future and Step SLA records no misses.
  const time = now.toISOString();
  const resource = buildFhirResource({ dataset, actionId, patientId, eventId, facilityId, time });
  const cloudEvent = buildCloudEvent({
    dataset,
    resource,
    patientId,
    eventId,
    facilityId,
    correlationId: buildCorrelationId(runId, n),
    source,
    time,
  });
  return { patientId, eventId, cloudEvent };
}

/** Refuses an empty or non-string value with the name of what was missing. */
function requireText(value, name) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${name} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
}

/** Refuses anything but a whole number ≥ 0 (iteration and phase numbers). */
function requireCount(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a whole number ≥ 0, got ${JSON.stringify(value)}`);
  }
}
