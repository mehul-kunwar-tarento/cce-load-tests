/**
 * preflight.mjs — run the preflight checks before a test and decide whether the test may start
 *
 * What:    Builds one context (environment, settings, the tested subjects and what their service modules
 *          `require`, injected clients), runs every check of checks/index.mjs that applies, and returns the
 *          preflight.json object (plan §5.5). A failed REQUIRED check makes the status `failed` (the run exits
 *          2); failed WARNING checks are reported as `warn` and give `passed-with-warnings`.
 *          Without subjects it is a "stack check": service health and the generic checks are required, the
 *          subject-specific ones run as warnings for every service the environment defines.
 * How:     const result = await runPreflight({ environment, subjects: ['matcher'], settings, clients });
 *          console.log(formatPreflightTable(result));  — CLI: node tools/cli.mjs preflight local --subject matcher
 * Needs:   clients = { db | pgPool, kafkaAdmin, http, scrapeUrl, exec, statfs, protocolApi, sleep, env }: a key
 *          passed by the caller is used as given (null = not available, the check says so); a key left out is
 *          built from the environment by clients.mjs and closed afterwards. Service modules come from
 *          `modules` or A2's service registry.
 * Outputs: PreflightResult { schemaVersion, kind, environment, subject, subjects, planDefinitionSet, startedAt,
 *          endedAt, status, checks[], warnings[] } — the caller writes it to preflight.json.
 */
import path from 'node:path';
import { REPO_ROOT } from '../core/paths.mjs';
import { buildChecks } from './checks/index.mjs';
import { completeClients } from './clients.mjs';
import { settingValues } from './probes.mjs';

/** Symbols of the printed table (plan §7.1). */
const SYMBOLS = { pass: '✔', fail: '✖', warn: '!', skip: '–' };

/**
 * Overall status from the check results.
 * Why: one rule for run, preflight command and tests: any failed required check → failed.
 */
export function preflightStatus(checks) {
  if (checks.some((c) => c.status === 'fail')) return 'failed';
  if (checks.some((c) => c.status === 'warn')) return 'passed-with-warnings';
  return 'passed';
}

/**
 * Find the service modules of the subjects (subject, kind, requires).
 * Why: required-vs-warning follows each module's `requires` (plan §6.4), not a table kept here.
 */
async function resolveModules(subjects, modules, modulesRoot) {
  if (modules) {
    return subjects.map((subject) => {
      const found = modules.find((m) => m.subject === subject || m.service === subject);
      if (!found) throw new Error(`No service module for subject "${subject}"`);
      return found;
    });
  }
  if (subjects.length === 0) return [];
  // Lazy: the registry scans the repository; unit tests always pass `modules`.
  const { getServiceModule } = await import('../core/service-registry.mjs');
  return Promise.all(
    subjects.map((s) => getServiceModule(s, modulesRoot ? { root: modulesRoot } : undefined)),
  );
}

/**
 * Run the preflight.
 * @param {object} p
 * @param {object} p.environment loaded environment (A2 loadEnvironment)
 * @param {string[]} [p.subjects] tested subjects; [] = stack check
 * @param {object} p.settings ResolvedSettings (or its `values`)
 * @param {string|null} [p.planDefinitionSetName] defaults to settings PLAN_DEFINITION_SET
 * @param {object} [p.clients] injected clients (see header)
 * @param {object[]} [p.modules] service modules (tests); else A2's registry
 * @param {string} [p.modulesRoot] where the service folders are (A2 --modules-root)
 * @param {string} [p.resultsRoot] results volume measured by disk.results
 * @param {string} [p.testDataRoot] test-data folder (plan-definition sets, datasets)
 * @param {() => Date} [p.now] clock (tests)
 */
export async function runPreflight({
  environment,
  subjects = [],
  settings,
  planDefinitionSetName,
  clients = {},
  modules = null,
  modulesRoot,
  resultsRoot = path.join(REPO_ROOT, 'results'),
  testDataRoot = path.join(REPO_ROOT, 'test-data'),
  now = () => new Date(),
}) {
  const startedAt = now();
  const values = settingValues(settings);
  const resolvedModules = await resolveModules(subjects, modules, modulesRoot);
  const env = clients.env ?? process.env;
  const completed = await completeClients(environment, clients, { env });
  const ctx = {
    environment,
    settings: values,
    resolved: settings?.values ? settings : { values },
    subjects: resolvedModules.map((m) => ({
      subject: m.subject,
      kind: m.kind,
      requires: m.requires ?? {},
    })),
    stackCheck: subjects.length === 0,
    planDefinitionSetName:
      planDefinitionSetName === undefined
        ? (values.PLAN_DEFINITION_SET ?? null)
        : planDefinitionSetName,
    clients: completed.clients,
    env,
    memo: new Map(),
    resultsRoot,
    testDataRoot,
    now,
  };

  const checks = [];
  try {
    for (const check of buildChecks(ctx)) {
      const t0 = Date.now();
      let severity = 'warning';
      let outcome;
      try {
        severity = check.severity(ctx);
        outcome = check.appliesTo(ctx)
          ? await check.run(ctx)
          : { status: 'skip', detail: 'not needed for this run', data: {} };
      } catch (error) {
        // A crashing check is a failed check with the reason, never a crashed preflight.
        outcome = { status: 'fail', detail: error.message, data: {} };
      }
      // A failure of a warning-level check is a warning (plan §7.1).
      const status = outcome.status === 'fail' && severity !== 'required' ? 'warn' : outcome.status;
      checks.push({
        id: check.id,
        title: check.title,
        severity,
        status,
        detail: outcome.detail ?? '',
        durationMs: Date.now() - t0,
        data: outcome.data ?? {},
      });
    }
  } finally {
    // Close only the clients preflight built itself; the caller's pool and Kafka admin stay open for the run.
    await completed.close();
  }

  const status = preflightStatus(checks);
  return {
    schemaVersion: '1.0.0',
    kind: 'cce-preflight',
    environment: environment?.name ?? null,
    subject: subjects.length === 1 ? subjects[0] : subjects.length ? subjects.join(',') : null,
    subjects,
    planDefinitionSet: ctx.planDefinitionSetName,
    startedAt: startedAt.toISOString(),
    endedAt: now().toISOString(),
    status,
    checks,
    warnings: checks.filter((c) => c.status === 'warn').map((c) => `${c.id}: ${c.detail}`),
  };
}

/**
 * The printed table: one line per check, then the verdict.
 * Why: a tester must see at a glance what blocks the run (✖) and what only deserves attention (!).
 */
export function formatPreflightTable(result) {
  const width = Math.max(...result.checks.map((c) => c.id.length), 10);
  const lines = [
    `Preflight ${result.environment}${result.subject ? ` (${result.subject})` : ' (stack check)'}`,
  ];
  for (const c of result.checks) {
    const level = c.severity === 'required' ? 'required' : 'warning ';
    lines.push(`  ${SYMBOLS[c.status] ?? '?'} ${c.id.padEnd(width)}  ${level}  ${c.detail}`);
  }
  const verdict = {
    passed: 'passed',
    'passed-with-warnings': `passed with ${result.warnings.length} warning(s)`,
    failed: 'FAILED: a required check did not pass, the run will not start',
  }[result.status];
  lines.push(`Preflight ${verdict}`);
  return lines.join('\n');
}
