/**
 * service-registry.mjs — finds the service modules (<folder>/service-module.mjs) the runner can test.
 *
 * What:    Each service folder (cce-collector-service/, …) has a service-module.mjs that tells the
 *          shared runner how to test that service (plan §6.4): its subject, k6 test files, expectation,
 *          watchers, data checks. The registry looks one folder deep under a root (default: the
 *          repository) and imports every module it finds, so a new service or adaptor folder plugs in
 *          without changing shared code.
 * How:     import { getServiceModule, listServiceModules } from './service-registry.mjs';
 *          const module = await getServiceModule('collector');            // or 'cce-collector-service'
 *          await getServiceModule('stub', { root: 'tools/core/unit-tests/fixtures' }); // --modules-root
 * Needs:   <root>/<folder>/service-module.mjs files exporting a default object (plan §6.4).
 * Outputs: Service module objects, each with an added `folder` (absolute path of its folder).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RefusedError } from './errors.mjs';
import { REPO_ROOT } from './paths.mjs';

/** Folders never searched: frozen code, installed packages, outputs, scratch. */
const SKIPPED = new Set(['archive', 'node_modules', 'results', '.cache', '.git']);

/** Fields every service module must have (plan §6.4). */
const REQUIRED_FIELDS = [
  'service',
  'subject',
  'idCode',
  'kind',
  'breakpointKind',
  'testTypes',
  'expectation',
  'dataChecks',
  'evaluate',
];

/**
 * Checks a module's shape and returns problems.
 * Why: a module with a missing function should fail at discovery with its file name, not mid-run.
 * @param {object} module
 * @returns {string[]}
 */
export function validateServiceModule(module) {
  const problems = [];
  for (const field of REQUIRED_FIELDS) {
    if (module?.[field] === undefined) problems.push(`missing "${field}"`);
  }
  if (module && !['k6', 'seeded'].includes(module.kind)) problems.push('kind must be k6 or seeded');
  if (module && !['staircase', 'flood', 'none'].includes(module.breakpointKind)) {
    problems.push('breakpointKind must be staircase, flood or none');
  }
  if (module?.kind === 'k6' && typeof module.testFile !== 'function')
    problems.push('k6 modules need testFile()');
  return problems;
}

/**
 * Imports every <root>/<folder>/service-module.mjs (one level deep).
 * Why: discovery instead of a hard-coded list keeps service folders independent (plan §10.1).
 * @param {{root?: string}} [options] root: absolute or relative to the current directory
 * @returns {Promise<object[]>} modules sorted by subject
 */
export async function listServiceModules({ root = REPO_ROOT } = {}) {
  const base = path.resolve(root);
  if (!fs.existsSync(base)) throw new RefusedError(`Modules root ${base} does not exist`);
  const modules = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIPPED.has(entry.name)) continue;
    const file = path.join(base, entry.name, 'service-module.mjs');
    if (!fs.existsSync(file)) continue;
    const imported = (await import(pathToFileURL(file).href)).default;
    const problems = validateServiceModule(imported);
    if (problems.length) {
      throw new Error(`${file} is not a valid service module: ${problems.join('; ')}`);
    }
    // A wrapper object: the module itself stays untouched, the runner learns where it lives.
    modules.push({ ...imported, folder: path.dirname(file) });
  }
  return modules.sort((a, b) => a.subject.localeCompare(b.subject));
}

/**
 * Finds one module by subject ('matcher') or service name ('cce-matcher-service').
 * Why: the CLI accepts either spelling; an unknown one lists what exists.
 * @param {string} subjectOrServiceName
 * @param {{root?: string}} [options]
 * @returns {Promise<object>}
 */
export async function getServiceModule(subjectOrServiceName, { root = REPO_ROOT } = {}) {
  const modules = await listServiceModules({ root });
  const found = modules.find(
    (module) => module.subject === subjectOrServiceName || module.service === subjectOrServiceName,
  );
  if (!found) {
    const known = modules.map((module) => module.subject).join(', ') || 'none';
    throw new RefusedError(
      `No service module for "${subjectOrServiceName}" under ${root} (known: ${known})`,
    );
  }
  return found;
}
