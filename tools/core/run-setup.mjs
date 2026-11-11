/**
 * run-setup.mjs — everything a run (or a settings printout) needs before anything connects.
 *
 * What:    Resolving the settings of a run needs more than defaults.json: the dataset says which event
 *          (action id), source and facility are the defaults, and the plan-definition set decides how
 *          many alarms one event creates (STEP_SLA_PEAK_ALARM_RATE=auto). This module does it in the
 *          right order, from files only (no network, D14):
 *            1. resolve once without a subject → PLAN_DEFINITION_SET, DATASET, version suffix
 *            2. load the set (A3 sets.mjs) and the dataset (test-data/datasets/<name>/dataset.json;
 *               DATASET empty = the set's first compatible dataset); an EVENT_ACTION_ID the dataset has
 *               no template for is refused (exit 2) here
 *            3. resolve again with subject, test type, breakpoint kind and the set's expected rows
 *            4. fill DATASET / EVENT_ACTION_ID / EVENT_SOURCE / FACILITY_ID from the dataset when left empty
 *          It also builds run-context.json (plan §3.5), the file k6 reads instead of env vars.
 * How:     const setup = await prepareRunSettings({ environment, module, testType, overrides, env });
 *          const context = buildRunContext({ setup, module, testType, environment, resultsDir, apiPort, startedAt });
 * Needs:   config/settings/defaults.json, test-data/ (datasets, plan-definition sets), A3's
 *          tools/plan-definitions/{sets,expected-rows}.mjs (imported lazily; a warning when absent).
 * Outputs: { resolved, dataset, planDefinitionSet, setContext, warnings } and the run-context object.
 */
import fs from 'node:fs';
import path from 'node:path';
import { environmentForK6 } from './environment.mjs';
import { RefusedError } from './errors.mjs';
import { toIsoWithOffset } from './format.mjs';
import { readConfigJson } from './json-file.mjs';
import { REPO_ROOT } from './paths.mjs';
import { applyDatasetDefaults, resolveSettings } from './settings.mjs';

/** run-context.json schema version (plan §3.5). */
export const RUN_CONTEXT_SCHEMA_VERSION = '1.0.0';

/**
 * Imports an optional module of another package, or returns null when its file does not exist yet.
 * Why: A3 (plan-definition sets) is built in parallel; settings and dry runs must work without it.
 * @param {string} relativeUrl relative to this file
 * @param {string} fileName the file name that may be missing (to tell "missing" from "broken")
 */
export async function importOptional(relativeUrl, fileName) {
  try {
    return await import(new URL(relativeUrl, import.meta.url));
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes(fileName))
      return null;
    throw error;
  }
}

/**
 * Reads a dataset (event templates, source, facility, default action id) without its "$comment".
 * Why: the dataset gives the defaults of EVENT_ACTION_ID, EVENT_SOURCE and FACILITY_ID (plan §3.2)
 * and goes into run-context.json for k6.
 * @param {string|null} name DATASET setting
 * @param {{testDataRoot?: string}} [options]
 * @returns {object|null} null when the dataset file does not exist
 */
export function loadDataset(name, { testDataRoot = path.join(REPO_ROOT, 'test-data') } = {}) {
  if (!name) return null;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new RefusedError(
      `DATASET "${name}" must be a folder name in test-data/datasets (kebab-case)`,
    );
  }
  const file = path.join(testDataRoot, 'datasets', name, 'dataset.json');
  if (!fs.existsSync(file)) return null;
  return readConfigJson(file);
}

/**
 * Loads the plan-definition set of a run through A3's sets.mjs (files only, no network).
 * Why: the set is a test parameter recorded with every result (R2) and feeds STEP_SLA_PEAK_ALARM_RATE=auto.
 * @param {string|null} name PLAN_DEFINITION_SET
 * @param {{versionSuffix?: string, testDataRoot?: string, warnings: string[]}} options
 * @returns {Promise<object|null>}
 */
export async function loadSetForRun(name, { versionSuffix = '', testDataRoot, warnings }) {
  if (!name) return null;
  const sets = await importOptional('../plan-definitions/sets.mjs', 'sets.mjs');
  if (!sets?.loadPlanDefinitionSet) {
    warnings.push(
      'tools/plan-definitions/sets.mjs is not available yet: the plan-definition set is recorded by name only',
    );
    return { name, fanOut: null, planDefinitions: [] };
  }
  return sets.loadPlanDefinitionSet(name, {
    versionSuffix: versionSuffix ?? '',
    ...(testDataRoot ? { testDataRoot } : {}),
  });
}

/**
 * Expected rows per event of the set (A3 computeExpectedRows), or null when unknown.
 * Why: STEP_SLA_PEAK_ALARM_RATE=auto needs the DUE alarms one event creates (plan §3.2).
 * @param {object|null} set
 * @param {string|null} actionId
 * @param {string[]} warnings
 * @returns {Promise<{expectedRows: object}|null>}
 */
export async function computeSetContext(set, actionId, warnings) {
  if (!set?.planDefinitions?.length || !actionId) return null;
  const module = await importOptional('../plan-definitions/expected-rows.mjs', 'expected-rows.mjs');
  if (!module?.computeExpectedRows) {
    warnings.push(
      'tools/plan-definitions/expected-rows.mjs is not available yet: expected rows unknown',
    );
    return null;
  }
  try {
    return { expectedRows: module.computeExpectedRows(set, actionId) };
  } catch (error) {
    // E.g. a set without that action: Step SLA's "auto" peak stays unresolved, the rest still works.
    warnings.push(`expected rows of set ${set.name} for ${actionId} unknown: ${error.message}`);
    return null;
  }
}

/**
 * Refuses an EVENT_ACTION_ID the dataset has no event template for, listing the valid ids.
 * Why: the k6 scenario only finds out per iteration (every event errors); `settings`, `run --dry-run`
 *      and `run` all resolve through prepareRunSettings, so the typo stops all of them with exit 2.
 * @param {string|null} actionId EVENT_ACTION_ID as resolved (null = the dataset's default)
 * @param {object|null} dataset loadDataset()
 */
export function assertKnownActionId(actionId, dataset) {
  if (!actionId || !dataset?.eventTemplates) return;
  if (Object.hasOwn(dataset.eventTemplates, actionId)) return;
  throw new RefusedError(
    `EVENT_ACTION_ID "${actionId}" has no event template in dataset ${dataset.name}: use one of ` +
      `${Object.keys(dataset.eventTemplates).join(', ')}`,
  );
}

/**
 * The dataset a run sends: DATASET when set, else the first compatible dataset of the plan-definition set.
 * Why: each set's plan definitions only react to its own EMR's events (emr-service ↔ ebuzima-emr,
 * kenya-sha-emr-service ↔ tiberbu-emr); choosing the set should be enough.
 * @param {string|null} name DATASET setting (null = empty)
 * @param {{compatibleDatasets?: string[]}|null} set
 * @returns {string|null}
 */
export function datasetForRun(name, set) {
  if (name) return name;
  return set?.compatibleDatasets?.[0] ?? null;
}

/**
 * Resolves the settings of a run with its dataset and plan-definition set (see header).
 * Why: `settings`, `run` and `inspect-k6` must resolve exactly the same way.
 * @param {object} input
 * @param {object} input.environment loaded environment
 * @param {object|null} [input.module] service module (null: values only, no phase plan)
 * @param {string|null} [input.testType]
 * @param {Record<string, unknown>} [input.overrides] --set values
 * @param {Record<string, unknown>} [input.refinements] values from `run --refine-from` (source "refine-from")
 * @param {Record<string, string|undefined>} [input.env] environment variables
 * @param {Date} [input.now] run start (RUN_ID default)
 * @param {string} [input.testDataRoot]
 * @returns {Promise<{resolved:object, dataset:object|null, planDefinitionSet:object|null, setContext:object|null, warnings:string[]}>}
 */
export async function prepareRunSettings({
  environment,
  module = null,
  testType = null,
  overrides = {},
  refinements = {},
  env = process.env,
  now = new Date(),
  testDataRoot,
}) {
  const warnings = [];
  // Pass 1: only to learn which dataset and set this run uses.
  const first = resolveSettings({ environment, overrides, refinements, env, now });
  const planDefinitionSet = await loadSetForRun(first.values.PLAN_DEFINITION_SET, {
    versionSuffix: first.values.PLAN_DEFINITION_VERSION_SUFFIX ?? '',
    testDataRoot,
    warnings,
  });
  // DATASET empty = the set's first compatible dataset, so choosing the set alone sends events its
  // plan definitions react to (kenya-sha-emr-service → tiberbu-emr).
  const datasetName = datasetForRun(first.values.DATASET, planDefinitionSet);
  const dataset = loadDataset(datasetName, testDataRoot ? { testDataRoot } : {});
  if (datasetName && !dataset) {
    warnings.push(`dataset ${datasetName} not found in test-data/datasets/`);
  }
  // A typo in EVENT_ACTION_ID would make k6 throw on EVERY iteration (lib/test-data.js builds the event
  // per iteration), after preflight and the idle wait: refuse it here, before anything starts.
  assertKnownActionId(first.values.EVENT_ACTION_ID, dataset);
  const actionId = first.values.EVENT_ACTION_ID ?? dataset?.defaultActionId ?? null;
  const setContext = await computeSetContext(planDefinitionSet, actionId, warnings);

  // Pass 2: the real resolution (same `now`, so an automatic RUN_ID is identical).
  const withSubject = Boolean(module && testType);
  let resolved = resolveSettings({
    environment,
    subject: withSubject ? module.subject : null,
    testType: withSubject ? testType : null,
    breakpointKind: withSubject ? module.breakpointKind : null,
    setContext,
    overrides,
    refinements,
    env,
    now,
    idCode: module?.idCode ?? null,
  });
  resolved = applyDatasetDefaults(resolved, dataset);
  resolved.warnings = [...resolved.warnings, ...warnings];
  return { resolved, dataset, planDefinitionSet, setContext, warnings };
}

/**
 * The plan-definition set block of run-context.json: name and fan-out only (k6 needs no FHIR JSON).
 * Why: k6 tags its metrics with the set name; the full snapshot lives in result.conditions.
 * @param {object|null} set
 * @param {string|null} fallbackName
 */
function setSummary(set, fallbackName) {
  if (!set) return fallbackName ? { name: fallbackName, fanOut: null } : null;
  return { name: set.name, fanOut: set.fanOut ?? null };
}

/**
 * Builds run-context.json (plan §3.5): the ONLY input k6 gets (no env vars for settings).
 * Why: k6 and Node work from the same typed settings and phase plan; the database block is left out.
 * @param {object} input
 * @param {{resolved:object, dataset:object|null, planDefinitionSet:object|null}} input.setup prepareRunSettings()
 * @param {object} input.module service module
 * @param {string} input.testType
 * @param {object} input.environment
 * @param {{relativeDir:string, dirInContainer:string}} input.resultsDir
 * @param {number} input.apiPort k6 REST API port
 * @param {Date} input.startedAt
 * @returns {object}
 */
export function buildRunContext({
  setup,
  module,
  testType,
  environment,
  resultsDir,
  apiPort,
  startedAt,
}) {
  const { resolved, dataset, planDefinitionSet } = setup;
  return {
    schemaVersion: RUN_CONTEXT_SCHEMA_VERSION,
    runId: resolved.values.RUN_ID,
    subject: module.subject,
    service: module.service,
    idCode: module.idCode,
    testType,
    environment: environmentForK6(environment),
    settings: resolved.values,
    phasePlan: resolved.derived.phasePlan,
    dataset,
    planDefinitionSet: setSummary(planDefinitionSet, resolved.values.PLAN_DEFINITION_SET),
    k6: { apiPort },
    resultsDir: resultsDir.relativeDir,
    resultsDirInContainer: resultsDir.dirInContainer,
    startedAt: toIsoWithOffset(startedAt),
  };
}
