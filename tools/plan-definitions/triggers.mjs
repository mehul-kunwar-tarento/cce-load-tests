/**
 * triggers.mjs — read the structure of a FHIR PlanDefinition the way CCE does
 *
 * What:    Small, pure helpers shared by validation, expected rows and preflight: which actions are steps,
 *          groups or fire-event actions, which steps are mandatory, the trigger_index rows the protocol
 *          service would write for a plan definition, and the code triples the matcher reads from an event
 *          (a copy of the matcher's EventCodesExtractor, release-2.0.0).
 * How:     Imported by tools/plan-definitions/*.mjs and tools/preflight/checks/plan-definition-set.mjs.
 * Needs:   Nothing (pure functions, no I/O).
 * Outputs: Return values only.
 */

/** Code system + code that mark an action as a CCE "step" (cce-common-util PlanDefinitionActionType). */
export const STEP_TYPE = { system: 'http://openphc.org/fhir/CodeSystem/action-type', code: 'step' };
/** Code system + code that mark an intelligence ("fire-event") action. Note: a different system than step. */
export const FIRE_EVENT_TYPE = {
  system: 'http://terminology.hl7.org/CodeSystem/action-type',
  code: 'fire-event',
};
/** Extension that gives a mandatory step its deadline in days (Step SLA works from it). */
export const TOLERANCE_DAYS_URL = 'http://openphc.org/fhir/StructureDefinition/tolerance-days';
/** Extension that makes a group repeat in cycles (validated by the protocol service). */
export const CYCLE_BOUNDARY_URL = 'http://openphc.org/fhir/StructureDefinition/cycle-boundary';

/** Why: one place that answers "does this action carry the given type coding" (both system and code must match). */
function hasTypeCoding(action, type) {
  const codings = action?.type?.coding;
  if (!Array.isArray(codings)) return false;
  return codings.some((c) => c && c.system === type.system && c.code === type.code);
}

/** Why: CCE only knows two action kinds; anything else is rejected when the protocol is loaded. */
export function actionTypeOf(action) {
  if (hasTypeCoding(action, STEP_TYPE)) return 'step';
  if (hasTypeCoding(action, FIRE_EVENT_TYPE)) return 'fire-event';
  return null;
}

/** Why: a "group" is a step with groupingBehavior logical-group; it is never matched to an event itself. */
export function isGroup(action) {
  return actionTypeOf(action) === 'step' && action.groupingBehavior === 'logical-group';
}

/** Why: tolerance-days is how a step gets a deadline; returns the integer or null when absent. */
export function toleranceDaysOf(action) {
  const ext = (action?.extension ?? []).find((e) => e && e.url === TOLERANCE_DAYS_URL);
  return ext && Number.isInteger(ext.valueInteger) ? ext.valueInteger : null;
}

/**
 * Visit every action at every nesting level (depth first, document order).
 * Why: action ids must be unique across all levels, so validation needs every action, whatever its type.
 */
export function allActions(planDefinition) {
  const out = [];
  const visit = (actions, parent) => {
    for (const action of actions ?? []) {
      out.push({ action, parent });
      visit(action.action, action);
    }
  };
  visit(planDefinition?.action, null);
  return out;
}

/**
 * The steps the protocol service flattens: step actions and their nested step actions (groups included,
 * flagged). Fire-event children are leaves and are not descended into, exactly like flattenAction().
 */
export function flattenSteps(planDefinition) {
  const out = [];
  const visit = (actions, groupId) => {
    for (const action of actions ?? []) {
      if (actionTypeOf(action) !== 'step') continue;
      const group = isGroup(action);
      out.push({ action, id: action.id, group, groupId });
      // Nested steps belong to the nearest enclosing group (or the same one as their parent).
      visit(action.action, group ? action.id : groupId);
    }
  };
  visit(planDefinition?.action, null);
  return out;
}

/** Why: mandatory ("must") steps are the ones that get deadlines and therefore Step SLA alarms. */
export function mandatorySteps(planDefinition) {
  return flattenSteps(planDefinition)
    .filter((s) => !s.group && s.action.requiredBehavior === 'must')
    .map((s) => s.id);
}

/**
 * Mandatory steps that carry tolerance-days: the only steps the matcher gives a deadline (an alarm).
 * Why: a mandatory step may have no deadline (kenya-sha-emr-service consent-request); Step SLA seeding must
 * only create alarms the matcher could really create.
 */
export function deadlineSteps(planDefinition) {
  return flattenSteps(planDefinition)
    .filter((s) => !s.group && s.action.requiredBehavior === 'must')
    .filter((s) => toleranceDaysOf(s.action) !== null)
    .map((s) => s.id);
}

/**
 * The trigger_index rows the protocol service writes for a plan definition (buildTriggerIndexEntries):
 * one row per (data type, codeFilter path, coding) and a ('', '', '') row for a type-only trigger.
 * Why: the preflight overlap check and expected rows need to know which events a definition reacts to.
 */
export function triggerIndexRows(planDefinition) {
  const rows = [];
  for (const { action, group } of flattenSteps(planDefinition)) {
    if (group) continue; // a group's own triggers are never indexed
    for (const trigger of action.trigger ?? []) {
      for (const data of trigger.data ?? []) {
        if (!data || !data.type) continue;
        const filters = data.codeFilter ?? [];
        if (filters.length === 0) {
          rows.push({
            resourceType: data.type,
            path: '',
            codeSystem: '',
            codeValue: '',
            actionId: action.id,
          });
          continue;
        }
        for (const cf of filters) {
          for (const coding of cf.code ?? []) {
            rows.push({
              resourceType: data.type,
              path: cf.path ?? '',
              codeSystem: coding.system ?? '',
              // The service indexes the code, or the display when the code is absent (display-only codings, as the first dataset uses).
              codeValue: coding.code ?? coding.display ?? '',
              actionId: action.id,
            });
          }
        }
      }
    }
  }
  return rows;
}

/**
 * Code triples the matcher reads from an event's FHIR resource (EventCodesExtractor.extractCodes):
 * every top-level field except resourceType/id; text → (field, '', text); object or array of objects →
 * its coding[] entries, a bare Coding (code), or (array items only) an Identifier (system, value).
 */
export function extractEventCodes(resource) {
  const out = [];
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return out;
  const text = (v) => (typeof v === 'string' ? v : null);
  // Mirrors addCodePathTriple: code, or display when code is absent.
  const addCoding = (path, coding) => {
    const code = text(coding.code) ?? text(coding.display);
    if (code !== null) out.push({ path, system: text(coding.system) ?? '', code });
  };
  const fromObject = (path, node, arrayItem) => {
    if (Array.isArray(node.coding)) {
      for (const c of node.coding) if (c && typeof c === 'object') addCoding(path, c);
    } else if (text(node.code) !== null) {
      addCoding(path, node);
    } else if (arrayItem && text(node.value) !== null) {
      out.push({ path, system: text(node.system) ?? '', code: node.value });
    }
  };
  for (const [path, node] of Object.entries(resource)) {
    if (path === 'resourceType' || path === 'id' || path === '$comment') continue;
    if (typeof node === 'string') out.push({ path, system: '', code: node });
    else if (Array.isArray(node)) {
      for (const item of node)
        if (item && typeof item === 'object' && !Array.isArray(item)) fromObject(path, item, true);
    } else if (node && typeof node === 'object') fromObject(path, node, false);
  }
  return out;
}

/**
 * Find every FHIR resource (object with a string resourceType) inside a dataset JSON.
 * Why: the dataset's event templates are where the events' codes come from; their exact nesting is the
 * dataset's business, so we search rather than assume a shape.
 */
export function findResources(value, found = []) {
  if (Array.isArray(value)) {
    for (const v of value) findResources(v, found);
  } else if (value && typeof value === 'object') {
    if (typeof value.resourceType === 'string' && value.resourceType !== 'PlanDefinition') {
      found.push(value);
      return found; // a resource's own fields are not further events
    }
    for (const v of Object.values(value)) findResources(v, found);
  }
  return found;
}

/**
 * The (resource_type, path, code_system, code_value) tuples each event can match in trigger_index,
 * including the ('', '', '') row the matcher always adds for type-only triggers. De-duplicated per event.
 * Every tuple carries `eventNo` (index into `resources`): the matcher matches ONE event at a time, and an
 * action only matches when every codeFilter path of it is satisfied by that one event (AND semantics,
 * TriggerIndexRepository.findStructuralMatches), so tuples of different events must never be combined.
 * Why only the events: an earlier version added every trigger row of the set's own plan definitions as
 * "event tuples"; any other ACTIVE definition sharing a single code with ANY action of the set was then
 * counted as matching, inflating the effective fan-out.
 * @param {{resources?: object[]}} input the FHIR resources the run actually sends (one per event)
 * @returns {Array<{eventNo:number, resourceType:string, path:string, codeSystem:string, codeValue:string}>}
 */
export function matchTuples({ resources = [] }) {
  const seen = new Map();
  const add = (t) =>
    seen.set([t.eventNo, t.resourceType, t.path, t.codeSystem, t.codeValue].join('\u0001'), t);
  resources.forEach((r, eventNo) => {
    add({ eventNo, resourceType: r.resourceType, path: '', codeSystem: '', codeValue: '' });
    for (const c of extractEventCodes(r)) {
      add({
        eventNo,
        resourceType: r.resourceType,
        path: c.path,
        codeSystem: c.system,
        codeValue: c.code,
      });
    }
  });
  return [...seen.values()];
}
