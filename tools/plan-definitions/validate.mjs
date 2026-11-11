/**
 * validate.mjs — offline copy of the protocol service's load-time rules for a PlanDefinition, and set checks
 *
 * What:    Catches, before anything is posted, the mistakes the protocol service would reject with HTTP 400
 *          (cce-common-util PlanDefinitionParser, release-2.0.0): duplicate or missing action ids, unknown
 *          action types, triggers with neither data nor condition, unreadable codeFilter paths, unknown FHIR
 *          resource types, deadlines (tolerance-days) on optional steps or on groups, group rules and
 *          fire-event extensions. validateSet adds set-level checks (files exist, unique url+version, dataset).
 * How:     import { validatePlanDefinition, validateSet } from './validate.mjs';
 *          CLI: node tools/cli.mjs plan-definitions validate [--set <name>]
 * Needs:   validateSet reads test-data/plan-definition-sets/<name>/set.json and the files it names.
 * Outputs: Arrays of plain-language error strings (empty = valid).
 */
import { existsSync } from 'node:fs';
import {
  CYCLE_BOUNDARY_URL,
  actionTypeOf,
  allActions,
  flattenSteps,
  isGroup,
  toleranceDaysOf,
} from './triggers.mjs';

/** The FHIR R4 resource types HAPI's ResourceType enum accepts (trigger data.type must be one of them). */
export const KNOWN_RESOURCE_TYPES = new Set(
  (
    'Account ActivityDefinition AdverseEvent AllergyIntolerance Appointment AppointmentResponse AuditEvent Basic ' +
    'Binary BiologicallyDerivedProduct BodyStructure Bundle CapabilityStatement CarePlan CareTeam CatalogEntry ' +
    'ChargeItem ChargeItemDefinition Claim ClaimResponse ClinicalImpression CodeSystem Communication ' +
    'CommunicationRequest CompartmentDefinition Composition ConceptMap Condition Consent Contract Coverage ' +
    'CoverageEligibilityRequest CoverageEligibilityResponse DetectedIssue Device DeviceDefinition DeviceMetric ' +
    'DeviceRequest DeviceUseStatement DiagnosticReport DocumentManifest DocumentReference EffectEvidenceSynthesis ' +
    'Encounter Endpoint EnrollmentRequest EnrollmentResponse EpisodeOfCare EventDefinition Evidence ' +
    'EvidenceVariable ExampleScenario ExplanationOfBenefit FamilyMemberHistory Flag Goal GraphDefinition Group ' +
    'GuidanceResponse HealthcareService ImagingStudy Immunization ImmunizationEvaluation ImmunizationRecommendation ' +
    'ImplementationGuide InsurancePlan Invoice Library Linkage List Location Measure MeasureReport Media ' +
    'Medication MedicationAdministration MedicationDispense MedicationKnowledge MedicationRequest ' +
    'MedicationStatement MedicinalProduct MedicinalProductAuthorization MedicinalProductContraindication ' +
    'MedicinalProductIndication MedicinalProductIngredient MedicinalProductInteraction MedicinalProductManufactured ' +
    'MedicinalProductPackaged MedicinalProductPharmaceutical MedicinalProductUndesirableEffect MessageDefinition ' +
    'MessageHeader MolecularSequence NamingSystem NutritionOrder Observation ObservationDefinition ' +
    'OperationDefinition OperationOutcome Organization OrganizationAffiliation Parameters Patient PaymentNotice ' +
    'PaymentReconciliation Person PlanDefinition Practitioner PractitionerRole Procedure Provenance Questionnaire ' +
    'QuestionnaireResponse RelatedPerson RequestGroup ResearchDefinition ResearchElementDefinition ResearchStudy ' +
    'ResearchSubject RiskAssessment RiskEvidenceSynthesis Schedule SearchParameter ServiceRequest Slot Specimen ' +
    'SpecimenDefinition StructureDefinition StructureMap Subscription Substance SubstanceNucleicAcid ' +
    'SubstancePolymer SubstanceProtein SubstanceReferenceInformation SubstanceSourceMaterial ' +
    'SubstanceSpecification SupplyDelivery SupplyRequest Task TerminologyCapabilities TestReport TestScript ' +
    'ValueSet VerificationResult VisionPrescription'
  ).split(' '),
);

/** codeFilter.path must be one top-level field name (TriggerPath.isMatchable); empty = type-only trigger. */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9]*$/;
/** FHIR timing[x] choices: a group must not have any of them (repeating groups are not supported yet). */
const TIMING_KEYS = [
  'timingTiming',
  'timingDuration',
  'timingRange',
  'timingAge',
  'timingPeriod',
  'timingDateTime',
];
const INTELLIGENCE_SEVERITY_URL =
  'http://openphc.org/fhir/StructureDefinition/intelligence-severity';
const INTELLIGENCE_DESTINATION_URL =
  'http://openphc.org/fhir/StructureDefinition/intelligence-destination';

/** Why: "$comment" anywhere would make the protocol service's strict FHIR parser reject the resource. */
function findCommentKeys(value, path = '', found = []) {
  if (Array.isArray(value)) value.forEach((v, i) => findCommentKeys(v, `${path}[${i}]`, found));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === '$comment') found.push(path || '(top level)');
      else findCommentKeys(v, path ? `${path}.${k}` : k, found);
    }
  }
  return found;
}

/** Why: an extension "has a code" only with valueCode, exactly what extractCodeExtension reads. */
function codeExtension(action, url) {
  const ext = (action.extension ?? []).find((e) => e && e.url === url);
  return ext && typeof ext.valueCode === 'string' ? ext.valueCode : null;
}

/** Rules for one trigger list (validateActionTriggers + parseResourceType). */
function checkTriggers(action, errors) {
  for (const trigger of action.trigger ?? []) {
    const hasData = Array.isArray(trigger.data) && trigger.data.length > 0;
    const condition = trigger.condition?.expression;
    if (!hasData && !(typeof condition === 'string' && condition.trim() !== '')) {
      errors.push(`Action '${action.id}' has a trigger with no data[] and no condition`);
    }
    for (const data of trigger.data ?? []) {
      if (data?.type && !KNOWN_RESOURCE_TYPES.has(data.type)) {
        errors.push(
          `Action '${action.id}': unknown FHIR resource type in trigger data.type: ${data.type}`,
        );
      }
      for (const cf of data?.codeFilter ?? []) {
        const path = cf.path ?? '';
        if (path !== '' && !FIELD_NAME.test(path)) {
          errors.push(
            `Action '${action.id}': codeFilter.path '${path}' is not a single top-level field name, so it could never match`,
          );
        }
      }
    }
  }
}

/** Group rules of validateGroup (the ones that need no dependency graph). */
function checkGroup(group, insideRepeating, errors) {
  const id = group.id;
  if ((group.trigger ?? []).length > 0)
    errors.push(`Group '${id}' has a trigger; only its steps are matched to events`);
  const containsStep = (g) =>
    (g.action ?? []).some((n) => actionTypeOf(n) === 'step' && (!isGroup(n) || containsStep(n)));
  if (!containsStep(group))
    errors.push(`Group '${id}' contains no step, so it could never complete`);
  if (group.selectionBehavior && group.selectionBehavior !== 'all') {
    errors.push(
      `Group '${id}' has selectionBehavior '${group.selectionBehavior}'; only 'all' is supported`,
    );
  }
  if (toleranceDaysOf(group) !== null) {
    errors.push(
      `Group '${id}' declares tolerance-days; group deadlines are not supported (put them on its steps)`,
    );
  }
  if (TIMING_KEYS.some((k) => k in group))
    errors.push(`Group '${id}' declares a timing; repeating groups are not supported yet`);
  const boundary = (group.extension ?? []).find((e) => e && e.url === CYCLE_BOUNDARY_URL);
  if (boundary) {
    const code = boundary.valueCode ?? null;
    if (code !== 'calendar-day' && code !== 'entry-step') {
      errors.push(
        `Group '${id}' has cycle-boundary '${code}'; supported: calendar-day, entry-step`,
      );
    } else if (insideRepeating && code !== 'entry-step') {
      errors.push(
        `Group '${id}' repeats by ${code} inside another repeating group; only entry-step is allowed there`,
      );
    }
  }
  for (const nested of group.action ?? []) {
    if (actionTypeOf(nested) === 'fire-event') {
      errors.push(
        `Group '${id}' has the fire-event action '${nested.id}'; intelligence on groups is not supported yet`,
      );
    }
  }
}

/** Walk for validateGroupsIn: cycle-boundary only on groups, fire-event never a group, nested repetition. */
function checkGroupsIn(action, insideRepeating, errors) {
  if (actionTypeOf(action) === 'fire-event') {
    if (action.groupingBehavior === 'logical-group') {
      errors.push(
        `Action '${action.id}' is a fire-event action with groupingBehavior 'logical-group'`,
      );
    }
    return;
  }
  const group = isGroup(action);
  if (group) checkGroup(action, insideRepeating, errors);
  else if ((action.extension ?? []).some((e) => e && e.url === CYCLE_BOUNDARY_URL)) {
    errors.push(`Action '${action.id}' declares cycle-boundary but is not a step group`);
  }
  const repeating =
    group && (TIMING_KEYS.some((k) => k in action) || codeExtension(action, CYCLE_BOUNDARY_URL));
  for (const nested of action.action ?? [])
    checkGroupsIn(nested, insideRepeating || Boolean(repeating), errors);
}

/** Fire-event extension rule of buildIntelligenceActionInfo (only enforced when the action is complete). */
function checkFireEvent(action, errors) {
  const condition = (action.condition ?? []).find(
    (c) =>
      c?.kind === 'applicability' &&
      typeof c.expression?.expression === 'string' &&
      c.expression.expression,
  );
  // The service skips (does not reject) intelligence actions without a condition or a definitionCanonical.
  if (!condition || typeof action.definitionCanonical !== 'string') return;
  if (!codeExtension(action, INTELLIGENCE_SEVERITY_URL)) {
    errors.push(
      `Intelligence action '${action.id}' is missing required extension: intelligence-severity`,
    );
  }
  if (!codeExtension(action, INTELLIGENCE_DESTINATION_URL)) {
    errors.push(
      `Intelligence action '${action.id}' is missing required extension: intelligence-destination`,
    );
  }
}

/**
 * Validate one PlanDefinition against the protocol service's load rules.
 * Why: a 400 from a shared environment is slow to diagnose; the same rules offline give the reason at once.
 */
export function validatePlanDefinition(json) {
  const errors = [];
  if (!json || typeof json !== 'object') return ['Not a JSON object'];
  if (json.resourceType !== 'PlanDefinition')
    errors.push(`resourceType must be 'PlanDefinition' (found ${json.resourceType})`);
  for (const key of ['url', 'version']) {
    if (typeof json[key] !== 'string' || json[key].trim() === '')
      errors.push(`'${key}' is required (url + version identify a protocol)`);
  }
  if (!Array.isArray(json.action) || json.action.length === 0)
    errors.push('At least one action is required');
  for (const where of findCommentKeys(json))
    errors.push(`"$comment" at ${where} must be stripped before loading`);

  // validateActionIds: every action at every level has a unique, non-blank id.
  const seen = new Set();
  for (const { action } of allActions(json)) {
    if (typeof action.id !== 'string' || action.id.trim() === '') {
      errors.push(`Action with title '${action.title ?? '<untitled>'}' is missing a required id`);
    } else if (seen.has(action.id))
      errors.push(`Duplicate action id '${action.id}' (ids must be unique across all levels)`);
    else seen.add(action.id);
  }

  // validateActionTypes: top-level actions and the children of step actions need step|fire-event coding.
  const checkTypes = (actions) => {
    for (const action of actions ?? []) {
      const type = actionTypeOf(action);
      if (!type) errors.push(`Action '${action.id}' must have type coding 'step' or 'fire-event'`);
      if (type === 'step') checkTypes(action.action);
      if (type === 'fire-event') checkFireEvent(action, errors);
    }
  };
  checkTypes(json.action);

  // validateTriggers: steps (incl. nested steps) — groups are checked by the group rules instead.
  for (const { action, group } of flattenSteps(json)) if (!group) checkTriggers(action, errors);

  // validateGroups (without the dependency-graph rules, noted in the spec).
  for (const action of json.action ?? []) checkGroupsIn(action, false, errors);
  const groupIds = new Set(
    flattenSteps(json)
      .filter((s) => s.group)
      .map((s) => s.id),
  );
  for (const { action } of allActions(json)) {
    for (const rel of action.relatedAction ?? []) {
      if (groupIds.has(rel.actionId) && String(rel.relationship ?? '').startsWith('after')) {
        errors.push(
          `Action '${action.id}' follows group '${rel.actionId}'; group completion is not supported yet`,
        );
      }
    }
  }

  // validateOptionalStepDeadlines: tolerance-days only on requiredBehavior 'must' steps.
  for (const { action, group } of flattenSteps(json)) {
    if (!group && toleranceDaysOf(action) !== null && action.requiredBehavior !== 'must') {
      errors.push(
        `Optional action '${action.id}' (requiredBehavior=${action.requiredBehavior ?? '<absent>'}) declares tolerance-days; only 'must' steps can have a deadline`,
      );
    }
  }
  return errors;
}

/**
 * Validate a loaded set (from sets.mjs loadPlanDefinitionSet) plus its raw description.
 * Why: a set is only usable if every file exists, every definition is valid, url+version are unique
 * (the service refuses duplicates) and the chosen dataset is one the set was built for.
 * @param {object} set  { name, planDefinitions:[{file, url, version, json}], compatibleDatasets, entries? }
 * @param {{ dataset?: string|null, fileExists?: (p:string)=>boolean }} options
 */
export function validateSet(set, { dataset = null, fileExists = existsSync } = {}) {
  const errors = [];
  if (!set || !Array.isArray(set.planDefinitions) || set.planDefinitions.length === 0) {
    return [`Set '${set?.name ?? '?'}' has no plan definitions`];
  }
  // Files named by set.json (absolute paths recorded by the loader) must exist.
  for (const entry of set.entries ?? []) {
    if (entry.filePath && !fileExists(entry.filePath))
      errors.push(`Set '${set.name}': file not found: ${entry.filePath}`);
  }
  const canonicals = new Set();
  for (const pd of set.planDefinitions) {
    const label = pd.file;
    for (const e of validatePlanDefinition(pd.json)) errors.push(`${label}: ${e}`);
    const canonical = `${pd.url}|${pd.version}`;
    if (canonicals.has(canonical))
      errors.push(`Set '${set.name}': duplicate url+version ${canonical}`);
    canonicals.add(canonical);
  }
  if (
    dataset &&
    Array.isArray(set.compatibleDatasets) &&
    !set.compatibleDatasets.includes(dataset)
  ) {
    errors.push(
      `Set '${set.name}' is not compatible with dataset '${dataset}' (compatible: ${set.compatibleDatasets.join(', ')})`,
    );
  }
  return errors;
}
