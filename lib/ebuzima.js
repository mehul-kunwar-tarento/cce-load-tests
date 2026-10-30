// eBUZIMA test data: the FHIR resources eBUZIMA sends, one builder per step of the eBUZIMA protocol
// (protocol/emr-service-protocol.json, "EMR Service Diabetes Screening & Management Protocol").
// Shapes follow openhim-cce-emitter-adaptor's src/test/resources/ebuzima/ samples:
//   - Encounter types carry a display only, no code (VISIT_ENCOUNTER, CONSULTATION_ENCOUNTER,
//     TRANSFER_ENCOUNTER); the matcher matches on the display when the code is missing.
//   - hospitalization.origin is the facility (the adaptor and matcher read it for Encounters).
//   - Every resource has subject = Patient/<UPID>, and a clinical time the matcher reads
//     (period.start, effectiveDateTime, authoredOn, recordedDate).
// Builders take { id, patient, facility, time }. The tests use id = <patient>-<step>, so the step an
// event was sent for can be read back from the stored payload.
// Every patient ID passed in should start with LOADTEST- so cleanup.sh finds the data.

const LOINC = 'http://loinc.org';
const OBS_CATEGORY = 'http://terminology.hl7.org/CodeSystem/observation-category';

const encounter = (type) => (p) => ({
  resourceType: 'Encounter',
  id: p.id,
  status: 'finished',
  class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
  type: [{ coding: [{ display: type }] }],
  subject: { reference: `Patient/${p.patient}` },
  period: { start: p.time, end: p.time },
  hospitalization: { origin: { reference: `Location/${p.facility}` } },
});

const observation = (category, code, display, value) => (p) => ({
  resourceType: 'Observation',
  id: p.id,
  status: 'final',
  category: [{ coding: [{ system: OBS_CATEGORY, code: category }] }],
  code: { coding: [{ system: LOINC, code, display }] },
  subject: { reference: `Patient/${p.patient}` },
  effectiveDateTime: p.time,
  ...value,
});

// The protocol's steps in order: action id in the plan definition → the resource that completes it.
export const STEPS = {
  'visit-encounter': encounter('VISIT_ENCOUNTER'),
  'vitals-recording': observation('vital-signs', '8716-3', 'Vital signs', { valueString: 'BP 120/80' }),
  consultation: encounter('CONSULTATION_ENCOUNTER'),
  'chief-complaints': observation('exam', '33747-0', 'Chief Complaints', { valueString: 'headache' }),
  'history-assessment': observation('exam', '10164-2', 'History of Present illness Narrative', { valueString: 'none' }),
  'lab-order': (p) => ({
    resourceType: 'ServiceRequest',
    id: p.id,
    status: 'active',
    intent: 'order',
    code: { coding: [{ system: LOINC, code: '2339-0', display: 'Glucose [Mass/volume] in Blood' }] },
    subject: { reference: `Patient/${p.patient}` },
    authoredOn: p.time,
  }),
  'lab-results': observation('laboratory', '2339-0', 'Glucose [Mass/volume] in Blood', {
    valueQuantity: { value: 140, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' },
  }),
  diagnosis: (p) => ({
    resourceType: 'Condition',
    id: p.id,
    clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
    code: { coding: [{ system: 'http://snomed.info/sct', code: '44054006', display: 'Diabetes mellitus type 2' }] },
    subject: { reference: `Patient/${p.patient}` },
    recordedDate: p.time,
  }),
  treatment: (p) => ({
    resourceType: 'MedicationRequest',
    id: p.id,
    status: 'active',
    intent: 'order',
    medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '860975', display: 'Metformin 500 MG' }] },
    subject: { reference: `Patient/${p.patient}` },
    authoredOn: p.time,
  }),
  referral: encounter('TRANSFER_ENCOUNTER'),
};

const ALL = Object.keys(STEPS);
const WITHOUT_REFERRAL = ALL.filter((s) => s !== 'referral');

// The patient journeys a test cycles through, 10 patients at a time, so the mix is exact:
//   1 in 10 only checks in (visit), so vitals is never recorded and goes OVERDUE;
//   2 in 10 stop after the chief complaints, leaving the history step open;
//   6 in 10 complete the visit up to treatment;
//   1 in 10 also gets referred.
// That's 7.3 events per patient on average.
export const JOURNEYS = [
  ['visit-encounter'],
  ALL.slice(0, 4), ALL.slice(0, 4),
  WITHOUT_REFERRAL, WITHOUT_REFERRAL, WITHOUT_REFERRAL, WITHOUT_REFERRAL, WITHOUT_REFERRAL, WITHOUT_REFERRAL,
  ALL,
];
export const EVENTS_PER_PATIENT = JOURNEYS.reduce((n, j) => n + j.length, 0) / JOURNEYS.length;

// One eBUZIMA visit Encounter, for the single-service tests that send one event per patient.
export const visitEncounter = (patient, facility) =>
  STEPS['visit-encounter']({ id: `${patient}-visit-encounter`, patient, facility, time: new Date().toISOString() });
