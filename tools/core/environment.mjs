/**
 * environment.mjs — loads and checks config/environments/<env>.json; refuses prod.
 *
 * What:    An environment file says where the CCE services, Kafka, Postgres, k6 and monitoring are
 *          (plan §3.1). This module reads it, deep-merges a personal <env>.local.json over it, checks
 *          the rules (kind local/dev/uat; nothing named or marked prod; no password in the file) and
 *          maps a test subject to its services.<key> entry (step-sla → stepSla, plan §2.1).
 * How:     import { loadEnvironment, serviceConfig } from './environment.mjs';
 *          const environment = loadEnvironment('local');  serviceConfig(environment, 'step-sla');
 * Needs:   config/environments/<env>.json (and optionally <env>.local.json, git-ignored).
 * Outputs: The environment object plus `configFile` (repository-relative path). Throws RefusedError
 *          (exit 2) for prod, an unknown environment or an invalid file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { RefusedError } from './errors.mjs';
import { readConfigJson } from './json-file.mjs';
import { FOLDERS, repoPath, toRepoRelative } from './paths.mjs';

export { RefusedError } from './errors.mjs';

/** Environment kinds that exist; there is deliberately no 'prod' (plan §3.1). */
export const ENVIRONMENT_KINDS = ['local', 'dev', 'uat'];

/** Subjects whose environment key differs from the subject name (plan §2.1 "one spelling per place"). */
const SUBJECT_TO_KEY = { 'step-sla': 'stepSla' };

/** True for any name that looks like production; why: prod is refused by every command. */
function looksLikeProd(text) {
  return /prod/i.test(String(text ?? ''));
}

/**
 * Deep-merges plain objects (arrays and values are replaced, not merged).
 * Why: <env>.local.json overrides a few fields of <env>.json without copying the whole file.
 * @param {object} base
 * @param {object} override
 * @returns {object}
 */
export function deepMerge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    const isPlainObject = value && typeof value === 'object' && !Array.isArray(value);
    result[key] =
      isPlainObject && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])
        ? deepMerge(result[key], value)
        : value;
  }
  return result;
}

/**
 * Lists environment names that have a file (example templates excluded).
 * Why: "unknown environment" messages show what can be used instead.
 * @param {{configDir?: string}} [options]
 * @returns {string[]}
 */
export function listEnvironments({ configDir = repoPath(FOLDERS.environments) } = {}) {
  if (!fs.existsSync(configDir)) return [];
  return fs
    .readdirSync(configDir)
    .filter((file) => file.endsWith('.json') && !/\.(example|local|schema)\.json$/.test(file))
    .map((file) => file.replace(/\.json$/, ''))
    .sort();
}

/**
 * Checks an environment object against the rules of plan §3.1.
 * Why: a typo in an environment file should stop a run before anything connects.
 * @param {object} environment
 * @returns {string[]} problems (empty when valid)
 */
export function validateEnvironment(environment) {
  const problems = [];
  const need = (condition, message) => condition || problems.push(message);
  need(environment && typeof environment === 'object', 'environment must be a JSON object');
  if (problems.length) return problems;
  need(typeof environment.name === 'string' && environment.name !== '', 'name is required');
  need(
    ENVIRONMENT_KINDS.includes(environment.kind),
    `kind must be one of ${ENVIRONMENT_KINDS.join(', ')}`,
  );
  for (const key of ['collector', 'matcher', 'stepSla', 'protocol']) {
    need(
      typeof environment.services?.[key]?.baseUrl === 'string',
      `services.${key}.baseUrl is required`,
    );
  }
  need(Array.isArray(environment.kafka?.brokers), 'kafka.brokers must be a list');
  need(typeof environment.kafka?.inboundTopic === 'string', 'kafka.inboundTopic is required');
  need(typeof environment.database?.name === 'string', 'database.name is required');
  need(
    typeof environment.database?.passwordEnvVar === 'string',
    'database.passwordEnvVar is required (the NAME of the env var holding the password)',
  );
  // Secrets never live in files (D15).
  need(
    environment.database?.password === undefined,
    'database.password must not be in a file: use passwordEnvVar',
  );
  need(typeof environment.k6?.image === 'string', 'k6.image is required');
  need(typeof environment.k6?.dockerNetwork === 'string', 'k6.dockerNetwork is required');
  need(
    typeof environment.monitoring?.enabled === 'boolean',
    'monitoring.enabled must be true or false',
  );
  need(
    typeof environment.safety === 'object' && environment.safety !== null,
    'safety block is required',
  );
  return problems;
}

/**
 * Loads an environment by name, merges <name>.local.json and validates it.
 * Why: the first step of every command; refusing prod here protects every command at once.
 * @param {string} name e.g. 'local'
 * @param {{configDir?: string, root?: string}} [options] configDir: folder of the environment files
 * @returns {object} environment with `configFile`
 */
export function loadEnvironment(name, { configDir = repoPath(FOLDERS.environments), root } = {}) {
  if (!name)
    throw new RefusedError('No environment given: use e.g. local (config/environments/local.json)');
  if (looksLikeProd(name)) {
    throw new RefusedError(`Environment "${name}" looks like production: prod is always refused`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new RefusedError(
      `Environment name "${name}" must be lowercase letters, digits and hyphens`,
    );
  }
  const file = path.join(configDir, `${name}.json`);
  if (!fs.existsSync(file)) {
    const known = listEnvironments({ configDir });
    throw new RefusedError(
      `Unknown environment "${name}": no ${file}. Known: ${known.join(', ') || 'none'}` +
        ' (copy dev.example.json / uat.example.json to create one)',
    );
  }
  let environment = readConfigJson(file);
  // Personal overrides (git-ignored), deep-merged over the shared file.
  const localFile = path.join(configDir, `${name}.local.json`);
  if (fs.existsSync(localFile)) environment = deepMerge(environment, readConfigJson(localFile));

  if (looksLikeProd(environment.name) || looksLikeProd(environment.kind)) {
    throw new RefusedError(`Environment file ${name}.json is marked as production: refused`);
  }
  const problems = validateEnvironment(environment);
  if (problems.length) {
    throw new RefusedError(`Environment ${name} is invalid:\n  - ${problems.join('\n  - ')}`);
  }
  return { ...environment, configFile: root ? toRepoRelative(file, root) : toRepoRelative(file) };
}

/**
 * The services.<key> entry of a test subject (or, for a later adaptor module, its adaptors.<key> entry).
 * Why: the only place that knows 'step-sla' is spelled 'stepSla' in environment JSON (plan §2.1); the
 *      adaptors fallback lets an adaptor module get preflight health checks without shared-code changes.
 * @param {object} environment
 * @param {string} subject e.g. 'collector', 'step-sla', 'protocol', or an adaptor key
 * @returns {object|null} the service entry, or null when the environment has none
 */
export function serviceConfig(environment, subject) {
  const key = SUBJECT_TO_KEY[subject] ?? subject;
  return environment?.services?.[key] ?? environment?.adaptors?.[key] ?? null;
}

/**
 * The environment block that goes into run-context.json: no database block (k6 never touches it).
 * Why: k6 needs service URLs and Kafka only; less data in the container means less to leak.
 * @param {object} environment
 * @returns {object}
 */
export function environmentForK6(environment) {
  return {
    name: environment.name,
    kind: environment.kind,
    services: environment.services,
    kafka: environment.kafka,
    // Later adaptor modules' addresses (plan §10.4); only present when the environment file has them.
    ...(environment.adaptors ? { adaptors: environment.adaptors } : {}),
  };
}
