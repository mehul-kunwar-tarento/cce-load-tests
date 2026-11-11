/**
 * sets.mjs — load a plan-definition set and decide whether it may be written to an environment
 *
 * What:    A plan-definition set (test-data/plan-definition-sets/<name>/set.json) names the plan definitions
 *          that must be ACTIVE during a test (e.g. "emr-service", "kenya-sha-emr-service"). This module loads a set: reads
 *          each PlanDefinition file, strips "$comment" keys (the protocol
 *          service's strict FHIR parser rejects unknown keys), appends PLAN_DEFINITION_VERSION_SUFFIX to the
 *          version, and lists each definition's mandatory steps. It also holds the write-safety gate for
 *          load/retire/delete (plan §7.3 rules 1–2) and the load-test marker (rule 3).
 * How:     import { loadPlanDefinitionSet, assertPlanDefinitionWriteAllowed } from './sets.mjs';
 * Needs:   test-data/ (A1): plan-definition-sets/<name>/set.json, plan-definitions/*.json.
 * Outputs: PlanDefinitionSet objects; throws RefusedError when a write is not allowed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { RefusedError } from '../core/errors.mjs';
import { readConfigJson, readJsonFile } from '../core/json-file.mjs';
import { repoPath } from '../core/paths.mjs';
import { deadlineSteps, mandatorySteps } from './triggers.mjs';

/** Default root of the test data (A1's folder). Tests pass their own root. */
export const DEFAULT_TEST_DATA_ROOT = repoPath('test-data');

/** The FHIR meta.tag that marks a plan definition as loaded by this tool (plan §7.3 rule 3). */
export const LOADTEST_MARKER = Object.freeze({
  system: 'http://openphc.org/fhir/CodeSystem/cce-performance-tests',
  code: 'loadtest',
});

/** Why: set names become folder names and appear in results; keep them plain kebab-case. */
const SET_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Old set names that results recorded before a rename, and the set that holds the same plan definitions now.
 * Why: check-data, reports and baselines re-load the set a past run recorded; "single" was the only set
 * whose plan definition is unchanged (the overlapping sets and their variants were removed).
 */
export const RENAMED_SETS = Object.freeze({ single: 'emr-service' });

/**
 * Remove every "$comment" key at any depth.
 * Why: verbatim FHIR fixtures may carry a "$comment" (plan §2.4); the service would reject the resource.
 */
export function stripCommentsDeep(value) {
  if (Array.isArray(value)) return value.map(stripCommentsDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (k !== '$comment') out[k] = stripCommentsDeep(v);
    return out;
  }
  return value;
}

/** Names of the sets that exist (folders holding a set.json). Why: error messages list the choices. */
export function listPlanDefinitionSets({ testDataRoot = DEFAULT_TEST_DATA_ROOT } = {}) {
  const dir = path.join(testDataRoot, 'plan-definition-sets');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'set.json')))
    .map((d) => d.name)
    .sort();
}

/**
 * Resolve a path written in set.json: relative to the test-data root (plan §7.3 example), else to the set folder.
 * Why: both spellings are natural for authors; the first one that exists wins.
 */
function resolveSetPath(testDataRoot, setDir, relative) {
  const fromRoot = path.resolve(testDataRoot, relative);
  if (fs.existsSync(fromRoot)) return fromRoot;
  const fromSet = path.resolve(setDir, relative);
  return fs.existsSync(fromSet) ? fromSet : fromRoot;
}

/**
 * Load a set by name.
 * Why: the single way every tool (preflight, plan-definitions, Step SLA seeding, conditions) sees a set,
 * so all of them agree on url, version (incl. suffix) and mandatory steps.
 * @returns {Promise<{name, description, fanOut, exclusive, compatibleDatasets, requiresActionDefinitions,
 *   versionSuffix, dir, entries, planDefinitions: Array<{file, url, version, canonical, name, title,
 *   mandatorySteps: string[], deadlineSteps: string[], json}>}>}
 */
export async function loadPlanDefinitionSet(
  name,
  { versionSuffix = '', testDataRoot = DEFAULT_TEST_DATA_ROOT } = {},
) {
  if (typeof name !== 'string' || !SET_NAME.test(name)) {
    throw new RefusedError(
      `Plan-definition set name "${name}" is not valid (use kebab-case, e.g. emr-service)`,
    );
  }
  if (Object.hasOwn(RENAMED_SETS, name)) name = RENAMED_SETS[name];
  const dir = path.join(testDataRoot, 'plan-definition-sets', name);
  const setFile = path.join(dir, 'set.json');
  if (!fs.existsSync(setFile)) {
    const known = listPlanDefinitionSets({ testDataRoot });
    throw new RefusedError(
      `Unknown plan-definition set "${name}" (no ${setFile}). Known: ${known.join(', ') || 'none'}`,
    );
  }
  const raw = readConfigJson(setFile);
  const entries = [];
  const planDefinitions = [];
  for (const entry of raw.planDefinitions ?? []) {
    if (entry.variant) {
      // Variants (overrides applied to a base) were removed: every plan definition is its own file.
      throw new RefusedError(
        `Set "${name}": "variant" is no longer supported (${entry.variant}); list the plan definition file itself`,
      );
    }
    const filePath = resolveSetPath(testDataRoot, dir, entry.file);
    entries.push({ file: entry.file, filePath });
    if (!fs.existsSync(filePath))
      throw new RefusedError(`Set "${name}": plan definition file not found: ${filePath}`);
    const json = stripCommentsDeep(readJsonFile(filePath));
    // The suffix keeps test definitions apart from real ones on shared environments (plan §3.2).
    if (versionSuffix) json.version = `${json.version}${versionSuffix}`;
    planDefinitions.push({
      file: entry.file,
      url: json.url,
      version: json.version,
      canonical: `${json.url}|${json.version}`,
      name: json.name ?? null,
      title: json.title ?? null,
      mandatorySteps: mandatorySteps(json),
      deadlineSteps: deadlineSteps(json),
      json,
    });
  }
  return {
    name: raw.name ?? name,
    description: raw.description ?? '',
    fanOut: planDefinitions.length, // every event of a compatible dataset matches each definition once
    exclusive: raw.exclusive === true,
    compatibleDatasets: raw.compatibleDatasets ?? [],
    requiresActionDefinitions: raw.requiresActionDefinitions ?? [],
    versionSuffix,
    dir,
    entries,
    planDefinitions,
  };
}

/**
 * Refuse a plan-definition write (load, retire, delete) that is not allowed on this environment.
 * Rules (plan §7.3): 1. safety.allowPlanDefinitionChanges must be true for every write;
 * 2. on dev/uat every definition needs a non-empty version suffix or a url containing /loadtest/,
 *    because the shipped definitions use real url+versions that may be ACTIVE for real there.
 */
export function assertPlanDefinitionWriteAllowed({ environment, set, action }) {
  const kind = environment?.kind;
  if (!['local', 'dev', 'uat'].includes(kind) || /prod/i.test(String(environment?.name))) {
    throw new RefusedError(
      `Plan-definition ${action} refused: environment "${environment?.name}" is not local/dev/uat`,
    );
  }
  if (environment?.safety?.allowPlanDefinitionChanges !== true) {
    throw new RefusedError(
      `Plan-definition ${action} refused: safety.allowPlanDefinitionChanges is not true in config/environments/${environment.name}.json`,
    );
  }
  if (kind === 'dev' || kind === 'uat') {
    const unsafe = (set?.planDefinitions ?? []).filter(
      (pd) =>
        !(set.versionSuffix && String(pd.version).endsWith(set.versionSuffix)) &&
        !String(pd.url).includes('/loadtest/'),
    );
    if (unsafe.length > 0) {
      throw new RefusedError(
        `Plan-definition ${action} refused on ${kind}: ${unsafe.map((pd) => pd.canonical).join(', ')} would use a real ` +
          'url+version. Set PLAN_DEFINITION_VERSION_SUFFIX (e.g. -loadtest) or use a /loadtest/ url (open question Q3/Q15).',
      );
    }
  }
}

/** Why: `load` marks what it posts so `retire`/`delete` can later prove the definition is ours. */
export function withLoadTestMarker(json) {
  const out = structuredClone(json);
  out.meta = { ...(out.meta ?? {}) };
  const tags = Array.isArray(out.meta.tag) ? [...out.meta.tag] : [];
  if (!tags.some((t) => t?.system === LOADTEST_MARKER.system && t?.code === LOADTEST_MARKER.code)) {
    tags.push({ ...LOADTEST_MARKER });
  }
  out.meta.tag = tags;
  return out;
}

/** True when a stored definition (protocol API `definition`) carries the load-test marker. */
export function hasLoadTestMarker(definition) {
  const tags = definition?.meta?.tag;
  return (
    Array.isArray(tags) &&
    tags.some((t) => t?.system === LOADTEST_MARKER.system && t?.code === LOADTEST_MARKER.code)
  );
}
