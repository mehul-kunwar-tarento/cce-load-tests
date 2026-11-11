/**
 * test-data-files.spec.mjs — checks the shipped test data: datasets, plan definitions and plan-definition sets
 *
 * What:    Loads every dataset, plan definition and set under test-data/ and checks they are complete and
 *          consistent: headers present, templates fill without leftovers, every action has a template,
 *          journeys use known action ids, set files point at existing files, and each set's plan
 *          definition has the expected mandatory steps (emr-service 3, kenya-sha-emr-service 5).
 * How:     node --test lib/unit-tests/
 * Needs:   Node.js 22; the files under test-data/.
 * Outputs: Test results on stdout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fillTemplate, buildFhirResource } from '../test-data.js';

const TEST_DATA = new URL('../../test-data/', import.meta.url);
const TOLERANCE = 'http://openphc.org/fhir/StructureDefinition/tolerance-days';

/** Reads a JSON file under test-data/. */
function readJson(relative) {
  return JSON.parse(readFileSync(new URL(relative, TEST_DATA), 'utf8'));
}

/** A header comment must name the four labels of plan §2.4. */
function assertHeader(json, file) {
  assert.equal(typeof json.$comment, 'string', `${file} has a "$comment" header`);
  for (const label of ['What', 'How', 'Needs', 'Outputs'])
    assert.match(json.$comment, new RegExp(`${label}:`), `${file} header has ${label}`);
}

/** Every action of a plan definition, at any depth. */
function allActions(planDefinition) {
  const out = [];
  const walk = (list) =>
    (list || []).forEach((action) => {
      out.push(action);
      walk(action.action);
    });
  walk(planDefinition.action);
  return out;
}

/** Ids of the mandatory ("must") actions, in document order. */
function mandatorySteps(planDefinition) {
  return allActions(planDefinition)
    .filter((a) => a.requiredBehavior === 'must')
    .map((a) => a.id);
}

const datasetNames = readdirSync(new URL('datasets/', TEST_DATA));

test('datasets: header, fields, templates fill completely, journeys use known actions', () => {
  assert.deepEqual([...datasetNames].sort(), ['ebuzima-emr', 'tiberbu-emr']);
  for (const name of datasetNames) {
    const file = `datasets/${name}/dataset.json`;
    const dataset = readJson(file);
    assertHeader(dataset, file);
    assert.equal(dataset.name, name);
    for (const field of ['source', 'facilityId', 'defaultActionId', 'description'])
      assert.equal(typeof dataset[field], 'string', `${file} ${field}`);
    assert.ok(
      dataset.eventTemplates[dataset.defaultActionId],
      `${file}: defaultActionId has a template`,
    );
    for (const actionId of Object.keys(dataset.eventTemplates)) {
      const resource = buildFhirResource({
        dataset,
        actionId,
        patientId: 'P',
        eventId: 'E',
        facilityId: 'F',
        time: 'T',
      });
      const text = JSON.stringify(resource);
      assert.doesNotMatch(text, /\{\{|\$comment/, `${file} ${actionId} filled completely`);
      assert.equal(resource.id, 'E');
      // Patient reference: subject, or patient on Consent and EpisodeOfCare (as FHIR defines them).
      assert.equal((resource.subject ?? resource.patient).reference, 'Patient/P');
    }
    for (const journey of dataset.journeys)
      for (const actionId of journey)
        assert.ok(dataset.eventTemplates[actionId], `${file}: journey action ${actionId}`);
  }
});

test('ebuzima-emr templates cover every action of the base plan definition', () => {
  const dataset = readJson('datasets/ebuzima-emr/dataset.json');
  const base = readJson('plan-definitions/emr-service-protocol.json');
  assert.deepEqual(
    Object.keys(dataset.eventTemplates).sort(),
    allActions(base)
      .map((a) => a.id)
      .sort(),
  );
  assert.equal(dataset.source, 'loadtest-emr');
  assert.equal(dataset.facilityId, 'LOADTEST-FACILITY-01');
  assert.equal(dataset.defaultActionId, 'visit-encounter');
  // Display-only encounter types, as the EMR sends them.
  const visit = fillTemplate(dataset.eventTemplates['visit-encounter'], {
    eventId: 'E',
    patientId: 'P',
    facilityId: 'F',
    time: 'T',
    endTime: 'T',
  });
  assert.deepEqual(visit.type, [{ coding: [{ display: 'VISIT_ENCOUNTER' }] }]);
  assert.equal(dataset.journeys.length, 10);
});

test('kenya-sha tiberbu-emr templates cover every action of the Kenya SHA plan definition', () => {
  const dataset = readJson('datasets/tiberbu-emr/dataset.json');
  const protocol = readJson('plan-definitions/kenya-sha-emr-service-protocol.json');
  assert.deepEqual(
    Object.keys(dataset.eventTemplates).sort(),
    allActions(protocol)
      .map((a) => a.id)
      .sort(),
  );
  assert.equal(dataset.source, 'loadtest-emr');
  assert.equal(dataset.facilityId, 'LOADTEST-FACILITY-01');
  // The protocol's enrolment step: a proposed patient Consent.
  assert.equal(dataset.defaultActionId, 'consent-request');
  const consent = fillTemplate(dataset.eventTemplates['consent-request'], {
    eventId: 'E',
    patientId: 'P',
    facilityId: 'F',
    time: 'T',
    endTime: 'T',
  });
  assert.equal(consent.status, 'proposed');
  assert.equal(consent.category[0].coding[0].code, '59284-0');
  // The adaptor reads the facility from the Organization reference (FacilityIdExtractor).
  assert.deepEqual(consent.organization, [{ reference: 'Organization/F' }]);
});

test('plan definitions: deadlines (tolerance-days) only on mandatory steps', () => {
  for (const file of readdirSync(new URL('plan-definitions/', TEST_DATA))) {
    for (const action of allActions(readJson(`plan-definitions/${file}`))) {
      const hasTolerance = (action.extension || []).some((e) => e.url === TOLERANCE);
      if (hasTolerance) assert.equal(action.requiredBehavior, 'must', `${file} ${action.id}`);
    }
  }
});

test('plan-definition sets: §7.3 shape, files exist, expected mandatory steps', () => {
  const expected = {
    'emr-service': {
      file: 'plan-definitions/emr-service-protocol.json',
      dataset: 'ebuzima-emr',
      must: ['vitals-recording', 'consultation', 'diagnosis'],
    },
    'kenya-sha-emr-service': {
      file: 'plan-definitions/kenya-sha-emr-service-protocol.json',
      dataset: 'tiberbu-emr',
      must: [
        'consent-request',
        'consent-verification',
        'visit-encounter',
        'patient-check-in',
        'diagnosis',
      ],
    },
  };
  assert.deepEqual(
    readdirSync(new URL('plan-definition-sets/', TEST_DATA)).sort(),
    Object.keys(expected).sort(),
  );
  for (const [name, want] of Object.entries(expected)) {
    const file = `plan-definition-sets/${name}/set.json`;
    const set = readJson(file);
    assertHeader(set, file);
    assert.equal(set.name, name);
    assert.deepEqual(set.planDefinitions, [{ file: want.file }]);
    assert.deepEqual(set.compatibleDatasets, [want.dataset]);
    assert.ok(datasetNames.includes(want.dataset));
    assert.equal(set.exclusive, false);
    assert.deepEqual(set.requiresActionDefinitions, []);
    assert.ok(existsSync(new URL(want.file, TEST_DATA)), `${file}: ${want.file} exists`);
    assert.deepEqual(mandatorySteps(readJson(want.file)), want.must, `${file}: mandatory steps`);
  }
});
