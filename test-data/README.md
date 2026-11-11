<!--
  What:    Explains the test data of the performance tests: event datasets, plan-definition fixtures and
           plan-definition sets, how each is used and how to add one; how test data is tagged.
  How:     Read before choosing DATASET / PLAN_DEFINITION_SET or adding new test data.
  Needs:   Nothing. Background: specs/000-performance-testing-setup/plan.md §2.3 (ids), §3.2 (settings),
           §7.3 (sets).
  Outputs: Documentation only. It also documents the fixtures in plan-definitions/ (verbatim FHIR, which
           cannot carry a header comment of its own).
-->

# Test data

The tests are not tied to one EMR or one plan definition. Three kinds of test data are kept apart:

| Kind | Folder | Chosen with | What it decides |
|---|---|---|---|
| **Dataset** | `datasets/<name>/dataset.json` | `DATASET` (default empty = the set's first compatible dataset) | *What the events look like*: the FHIR resource sent for each step (action id), the CloudEvent `source` and facility, the patient journeys |
| **Plan definition** | `plan-definitions/*.json` | (through a set) | *What CCE does with an event*: the protocol (FHIR PlanDefinition) whose triggers enrol patients and whose mandatory steps get deadlines (Step SLA alarms) |
| **Plan-definition set** | `plan-definition-sets/<name>/set.json` | `PLAN_DEFINITION_SET` (default `emr-service`) | *The test condition*: which plan definitions are ACTIVE together during the run. Saved with every result |

A **plan definition** (FHIR PlanDefinition) is the protocol CCE follows, e.g. "check-in, then vitals within 1 day,
then consultation…". **Mandatory** steps (`requiredBehavior: "must"`) get a deadline (the `tolerance-days`
extension); when it passes, Step SLA raises an alarm. A mandatory step **without** `tolerance-days` gets no
deadline and therefore no alarm (Kenya's `consent-request`). Several ACTIVE plan definitions with the same
triggers **overlap**: one event enrols the patient in each of them, multiplying the matcher's and Step SLA's
work.

Two protocols ship, one per EMR dataset, each in a set of its own (fan-out 1). The set is the test parameter
that says which protocol is ACTIVE; choosing it also chooses the dataset (`DATASET` empty → the set's first
`compatibleDatasets` entry). Overlap still matters, but only from *other* ACTIVE plan definitions of the
environment: preflight measures it and the matcher data checks expect the *effective* fan-out (see
"Plan-definition sets").

## Datasets

| Dataset | EMR | Plan definition it matches | Templates | Enrolment event (`defaultActionId`) |
|---|---|---|---|---|
| `ebuzima-emr` | eBUZIMA | `emr-service-protocol` (set `emr-service`) | 10 | `visit-encounter` (Encounter, display `VISIT_ENCOUNTER`) |
| `tiberbu-emr` | tibERbu (Kenya SHA) | `kenya-sha-emr-service-protocol` (set `kenya-sha-emr-service`) | 15 | `consent-request` (Consent, status `proposed`, LOINC `59284-0`) |

`datasets/ebuzima-emr/dataset.json` is the first dataset, ported from the first version's eBUZIMA builders
(`lib/ebuzima.js`; a scripted self-check showed all 10 templates and the journeys reproduce v1
exactly). Fields (both datasets):

| Field | Meaning |
|---|---|
| `name` | Same as the folder name |
| `source` | CloudEvent `source` (default `loadtest-emr`; overridable with `EVENT_SOURCE`) |
| `facilityId` | CloudEvent `facilityid` and the resources' `Location/…` (default `LOADTEST-FACILITY-01`; `FACILITY_ID`) |
| `defaultActionId` | Template sent by single-event tests: the enrolment step of the protocol (`EVENT_ACTION_ID`) |
| `eventTemplates` | One FHIR resource template per action id of the plan definition, with placeholders `{{patientId}}`, `{{eventId}}`, `{{facilityId}}`, `{{time}}`, `{{endTime}}` |
| `journeys` | Lists of action ids a patient walks through (for `EVENT_MODE=journey`, reserved for later work) |

In `ebuzima-emr` the Encounter types carry a display only (`VISIT_ENCOUNTER`, …), no code, exactly as this EMR
sends them; the matcher matches on the display.

`datasets/tiberbu-emr/dataset.json` holds one template per action of the Kenya SHA protocol (15). The shapes
follow the tibERbu emitter adaptor's own test fixtures (`openphc/tiberbu-cce-emitter-adaptor`, branch
`release-1.0.0`, `src/test/resources/fhir/*.json`) **after** its clinical-data redaction: only what CCE needs is
kept — the patient reference (`subject`, or `patient` on Consent and EpisodeOfCare), every element the protocol
triggers on (Consent status/category, EpisodeOfCare type/status, Encounter class/type, Observation
category/status, ServiceRequest category/status, MedicationRequest status/category, Composition type), the
clinical time, and the Organization reference the adaptor reads the facility from (`Consent.organization`,
`EpisodeOfCare.managingOrganization`, `Encounter.serviceProvider`, `Composition.custodian`,
`ServiceRequest.performer`). Codes use the protocol's systems (LOINC, SNOMED, HL7, the SHA episode-of-care
type system), and each template matches exactly one action. Its CloudEvent `source` is the same neutral
`loadtest-emr` as the other dataset.

**Add a dataset**: create `datasets/<kebab-name>/dataset.json` with the fields above and a `"$comment"`
header; one template per action id of the plan definitions it is meant for; then list the dataset name in
the `compatibleDatasets` of the sets it works with. Choose it with `DATASET=<kebab-name>`.

## Plan definitions

Both files are **verbatim** FHIR copies, so they carry no `"$comment"` header; they are described here instead
(plan §2.4).

| File | Source | url, version | Steps | Mandatory (`must`) | With a deadline (alarm) |
|---|---|---|---|---|---|
| `plan-definitions/emr-service-protocol.json` | first version, `protocol/emr-service-protocol.json` (the eBUZIMA EMR Service protocol) | `http://openphc.org/PlanDefinition/emr-service-protocol`, `1.0.0` | 10 | vitals-recording, consultation, diagnosis | the same 3 (1 day) |
| `plan-definitions/kenya-sha-emr-service-protocol.json` | `openphc/tiberbu-cce-emitter-adaptor`, branch `release-1.0.0`, commit `7a765a2`, `src/test/resources/plan-definition/` | `http://openphc.org/PlanDefinition/kenya-sha-emr-service-protocol`, `1.0.0` (resource id `kenya-sha-emr-outpatient-service-protocol`) | 15 | consent-request, consent-verification, visit-encounter, patient-check-in, diagnosis | consent-verification, visit-encounter, patient-check-in, diagnosis (1 day) |

The Kenya protocol enrols the patient on a proposed patient-privacy Consent (`consent-request`), then expects
its verification, an outpatient episode of care (`general-opd`), check-in (SNOMED `184047000`), vitals,
consultation (SNOMED `11429006`) with lab order/results, diagnosis, medication request/dispense and procedure
order/procedure, a patient summary (LOINC `60591-5`) and visit closure.

Variants (overrides that generated extra plan definitions from the EMR Service protocol: `strict`, `light`, `lab-focus`)
were **removed** on 2026-11-11 together with the sets that used them; a set entry with `"variant"` is refused.

**Add a plan definition**: a new verbatim FHIR file, documented in the table above, with a dataset whose
templates match its triggers. Run `node tools/cli.mjs plan-definitions validate` (offline) before using it.

**Load-test marker**: the fixtures do **not** contain it. When `plan-definitions load` posts a plan definition
it adds `meta.tag: [{ system: "http://openphc.org/fhir/CodeSystem/cce-performance-tests", code: "loadtest" }]`
at load time (A3, plan §7.3); `retire` and `delete` refuse any definition without it.

## Plan-definition sets

| Set | Plan definition (ACTIVE) | Dataset | Enrolment event | Mandatory / with a deadline | Fan-out | Rows per enrolment event | Step SLA seed pairs |
|---|---|---|---|---|---|---|---|
| `emr-service` (default) | `emr-service-protocol` | `ebuzima-emr` | `visit-encounter` | 3 / 3 | 1 | 1,1,1,2,3,2 · 1 due alarm | 3 |
| `kenya-sha-emr-service` | `kenya-sha-emr-service-protocol` | `tiberbu-emr` | `consent-request` | 5 / 4 | 1 | 1,1,1,2,3,2 · 1 due alarm | 4 |

Rows per enrolment event, in order: `matcher_event_log`, `protocol_instance`, `protocol_instance_history`,
`step_instance`, `step_instance_history`, `step_sla_state_transition` (`tools/plan-definitions/expected-rows.mjs`).
Step SLA seeds alarms only on mandatory steps **with** a deadline, because those are the only ones the matcher
gives an alarm.

Sets are named after their **protocols**, not their EMRs: the EMR names may appear only as dataset names
([docs/conventions.md](../docs/conventions.md) §8). Results recorded with the old set name `single` still
load (as `emr-service`, the same plan definition); the removed sets `overlapping-2` and `overlapping-4` no
longer load.

**Overlap.** No shipped set overlaps any more (each holds one plan definition), so the fan-out of a shipped set
is 1. Other ACTIVE plan definitions of the environment can still match the same events: preflight
(`plan-definition-set`) finds them and fails for the matcher unless `ALLOW_OTHER_ACTIVE_PLAN_DEFINITIONS=true`,
which makes the matcher data check `matcher.enrolments-equal-fan-out` expect the *effective* fan-out (set +
others). Never put two plan definitions without shared triggers in one set: the set loader (`fanOut`) assumes
every definition of a set matches every event of its dataset.

`set.json` fields: `name` (= folder), `description`, `planDefinitions` (`[{ "file" }]`, paths relative to
`test-data/`), `compatibleDatasets` (the first one is the dataset a run sends when `DATASET` is empty),
`exclusive` (true = fail preflight when any other ACTIVE plan definition overlaps, even with
`ALLOW_OTHER_ACTIVE_PLAN_DEFINITIONS=true`), `requiresActionDefinitions`.

**Add a set**: create `plan-definition-sets/<kebab-name>/set.json` with a `"$comment"` header; run
`node tools/cli.mjs plan-definitions validate --set <kebab-name>`; choose it with `PLAN_DEFINITION_SET=<kebab-name>`.

## Tagging test data (`LOADTEST-<runId>-…`)

Everything a run creates is recognisable (plan §2.3):

- patient id `LOADTEST-<runId>-<idCode>-<phaseIndex>-<n>` (`idCode` = `col`, `mat`, `sla`; `n` = k6 iteration),
- event id `<patientId>-<stepNumber>` (at most 50 characters, the collector's limit),
- correlation id `LOADTEST-<runId>-corr-<n>`, facility `LOADTEST-FACILITY-01`, source `loadtest-emr`.

Cleanup (`scripts/cleanup-test-data.sh`) and data checks select a run's rows by these ids. Built by
`lib/test-data.js`.

## `$comment` keys

Our JSON files start with a `"$comment"` (What/How/Needs/Outputs) and templates may carry their own
`"$comment"`. Every loader drops them: `fillTemplate` (`lib/test-data.js`) removes `"$comment"` at every
level, Node's `readConfigJson` drops the top-level one, and `tools/plan-definitions/sets.mjs` strips them
before posting. Nothing sent to a CCE service ever contains a `"$comment"`.
