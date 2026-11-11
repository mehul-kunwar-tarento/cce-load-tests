/**
 * test-data.spec.mjs — unit tests of lib/test-data.js (plan §2.3, §4.6)
 *
 * What:    Checks id formats, the 50-character event id guard, template filling (deep copy, placeholders,
 *          "$comment" dropped at every level), the FHIR resource and the CloudEvent shape.
 * How:     node --test lib/unit-tests/
 * Needs:   Node.js 22; a tiny in-test dataset (the real dataset is checked by test-data-files.spec.mjs).
 * Outputs: Test results on stdout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CLOUD_EVENT_ID_LENGTH,
  testDataPrefix,
  buildPatientId,
  buildEventId,
  buildCorrelationId,
  fillTemplate,
  buildFhirResource,
  buildCloudEvent,
  eventDefaults,
  buildIterationEvent,
} from '../test-data.js';

/** A minimal dataset in the shape of test-data/datasets/<name>/dataset.json. */
const DATASET = {
  name: 'sample-emr',
  source: 'loadtest-emr',
  facilityId: 'LOADTEST-FACILITY-01',
  defaultActionId: 'visit',
  eventTemplates: {
    visit: {
      $comment: 'documentation only',
      resourceType: 'Encounter',
      id: '{{eventId}}',
      type: [{ coding: [{ display: 'VISIT_ENCOUNTER', $comment: 'nested comment' }] }],
      subject: { reference: 'Patient/{{patientId}}' },
      period: { start: '{{time}}', end: '{{endTime}}' },
      hospitalization: { origin: { reference: 'Location/{{facilityId}}' } },
      priority: 1,
      active: true,
      note: null,
    },
  },
  journeys: [['visit']],
};

test('ids follow plan §2.3', () => {
  assert.equal(MAX_CLOUD_EVENT_ID_LENGTH, 50);
  assert.equal(testDataPrefix('20261105-142233'), 'LOADTEST-20261105-142233-');
  const patientId = buildPatientId({
    runId: '20261105-142233',
    idCode: 'col',
    phaseIndex: 1,
    n: 29999,
  });
  assert.equal(patientId, 'LOADTEST-20261105-142233-col-1-29999');
  assert.equal(buildEventId(patientId, 1), 'LOADTEST-20261105-142233-col-1-29999-1');
  assert.equal(buildCorrelationId('20261105-142233', 7), 'LOADTEST-20261105-142233-corr-7');
  assert.throws(() => buildPatientId({ runId: '', idCode: 'col', phaseIndex: 0, n: 0 }), /runId/);
  assert.throws(() => buildPatientId({ runId: 'x', idCode: 'c-l', phaseIndex: 0, n: 0 }), /hyphen/);
  assert.throws(
    () => buildPatientId({ runId: 'x', idCode: 'col', phaseIndex: -1, n: 0 }),
    /phaseIndex/,
  );
  assert.throws(() => buildEventId('p', 0), /stepNumber/);
});

test('default-length event ids fit in 50 characters; longer ones throw', () => {
  // Longest default: d8-d6 run id, phase 1, a 9-digit iteration number, step 99.
  const longest = buildEventId(
    buildPatientId({ runId: '20261105-142233', idCode: 'mat', phaseIndex: 1, n: 999999999 }),
    99,
  );
  assert.ok(longest.length <= 50, `${longest} has ${longest.length} characters`);
  // The longest custom RUN_ID (20 characters) with a huge iteration number goes over the limit.
  const longRun = buildPatientId({
    runId: 'A'.repeat(20),
    idCode: 'col',
    phaseIndex: 1,
    n: 9999999999999,
  });
  assert.throws(() => buildEventId(longRun, 99), /at most 50/);
  assert.equal(buildEventId('x'.repeat(48), 1).length, 50); // exactly 50 is allowed
  assert.throws(() => buildEventId('x'.repeat(48), 10), /at most 50/);
});

test('fillTemplate deep-copies, fills placeholders and drops $comment at every level', () => {
  const template = DATASET.eventTemplates.visit;
  const before = JSON.stringify(template);
  const filled = fillTemplate(template, {
    eventId: 'E',
    patientId: 'P',
    facilityId: 'F',
    time: 'T1',
    endTime: 'T2',
  });
  assert.deepEqual(filled, {
    resourceType: 'Encounter',
    id: 'E',
    type: [{ coding: [{ display: 'VISIT_ENCOUNTER' }] }],
    subject: { reference: 'Patient/P' },
    period: { start: 'T1', end: 'T2' },
    hospitalization: { origin: { reference: 'Location/F' } },
    priority: 1,
    active: true,
    note: null,
  });
  assert.equal(JSON.stringify(template), before, 'the template itself is unchanged');
  assert.equal(JSON.stringify(filled).includes('$comment'), false);
  assert.throws(() => fillTemplate({ a: '{{missing}}' }, {}), /\{\{missing\}\} has no value/);
});

test('buildFhirResource uses the dataset template; endTime defaults to time', () => {
  const resource = buildFhirResource({
    dataset: DATASET,
    actionId: 'visit',
    patientId: 'P',
    eventId: 'E',
    facilityId: 'F',
    time: 'T',
  });
  assert.deepEqual(resource.period, { start: 'T', end: 'T' });
  assert.throws(
    () =>
      buildFhirResource({
        dataset: DATASET,
        actionId: 'nope',
        patientId: 'P',
        eventId: 'E',
        facilityId: 'F',
        time: 'T',
      }),
    /no event template for action "nope"/,
  );
});

test('CloudEvent shape: source and facility from the dataset unless given', () => {
  const resource = { resourceType: 'Observation', id: 'E' };
  const event = buildCloudEvent({
    dataset: DATASET,
    resource,
    patientId: 'P',
    eventId: 'E',
    correlationId: 'C',
    time: 'T',
  });
  assert.deepEqual(event, {
    specversion: '1.0',
    id: 'E',
    source: 'loadtest-emr',
    type: 'Observation',
    subject: 'P',
    time: 'T',
    facilityid: 'LOADTEST-FACILITY-01',
    correlationid: 'C',
    datacontenttype: 'application/fhir+json',
    data: resource,
  });
  const custom = buildCloudEvent({
    dataset: DATASET,
    resource,
    patientId: 'P',
    eventId: 'E',
    source: 'other-emr',
    facilityId: 'FAC-2',
    time: 'T',
  });
  assert.equal(custom.source, 'other-emr');
  assert.equal(custom.facilityid, 'FAC-2');
  assert.equal('correlationid' in custom, false);
  assert.throws(
    () => buildCloudEvent({ dataset: {}, resource, patientId: 'P', eventId: 'E', time: 'T' }),
    /source/,
  );
});

test('eventDefaults: settings win over dataset defaults', () => {
  assert.deepEqual(
    eventDefaults({
      dataset: DATASET,
      settings: { EVENT_SOURCE: null, FACILITY_ID: null, EVENT_ACTION_ID: null },
    }),
    {
      source: 'loadtest-emr',
      facilityId: 'LOADTEST-FACILITY-01',
      actionId: 'visit',
    },
  );
  assert.equal(eventDefaults({ dataset: DATASET, settings: { FACILITY_ID: 'X' } }).facilityId, 'X');
});

test('buildIterationEvent puts it all together', () => {
  const context = { runId: '20261105-142233', idCode: 'col', dataset: DATASET, settings: {} };
  const now = new Date('2026-11-05T08:52:33.000Z');
  const { patientId, eventId, cloudEvent } = buildIterationEvent({
    context,
    phaseIndex: 1,
    n: 5,
    now,
  });
  assert.equal(patientId, 'LOADTEST-20261105-142233-col-1-5');
  assert.equal(eventId, `${patientId}-1`);
  assert.equal(cloudEvent.id, eventId);
  assert.equal(cloudEvent.time, '2026-11-05T08:52:33.000Z');
  assert.equal(cloudEvent.correlationid, 'LOADTEST-20261105-142233-corr-5');
  assert.equal(cloudEvent.data.subject.reference, `Patient/${patientId}`);
  assert.equal(cloudEvent.data.id, eventId);
});
