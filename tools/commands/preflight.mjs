/**
 * preflight.mjs — CLI command `preflight`: check an environment before running tests
 *
 * What:    Answers "may a test start now?" without sending any test traffic: services healthy (actuator
 *          health, called once), metrics present, Postgres is the expected database, Kafka topic and the
 *          matcher's consumer group are fine, the plan-definition set is ACTIVE (and nothing else ACTIVE
 *          matches the dataset's events), disk/WAL headroom, autovacuum, leftover test data, Step SLA
 *          scheduler alive, monitoring reachable (plan §7.1). Prints ✔/✖/!/– per check. Separate from the
 *          smoke test. `run` calls the same runPreflight before every test.
 * How:     node tools/cli.mjs preflight local [--subject matcher]… [--set NAME=value]… [--json] [--out <file>]
 *          scripts/check-services.sh local --subject matcher
 * Needs:   config/environments/<env>.json; the DB password env var (database.passwordEnvVar) for the database
 *          checks; GRAFANA_API_TOKEN or GRAFANA_ADMIN_PASSWORD for annotations (presence only); a running stack.
 * Outputs: stdout table or JSON (preflight.json shape, plan §5.5); optional --out file;
 *          exit 0 passed / passed with warnings, 2 a required check failed or refused, 3 tool error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCommandArgs } from '../core/command-args.mjs';
import { loadEnvironment } from '../core/environment.mjs';
import { EXIT, UsageError } from '../core/errors.mjs';
import { REPO_ROOT } from '../core/paths.mjs';
import { parseSetArgs, resolveSettings } from '../core/settings.mjs';
import { formatPreflightTable, runPreflight } from '../preflight/preflight.mjs';

export const description =
  'Check services, Postgres, Kafka, plan-definition set, disk/WAL and monitoring before a run';
export const usage = `Usage: preflight <env> [--subject <subject>]… [--set NAME=value]… [--json] [--out <file>] [--modules-root <dir>]

  <env>             environment name (config/environments/<env>.json), e.g. local
  --subject <s>     subject to be tested (collector, matcher, step-sla); repeatable.
                    Without --subject: a stack check of every service (and adaptor) the environment defines.
  --set NAME=value  override a setting for this check (e.g. --set PLAN_DEFINITION_SET=kenya-sha-emr-service)
  --json            print the preflight JSON instead of the table
  --out <file>      also write the preflight JSON to this file
  --modules-root    where the service folders are (default: repository root)

Exit codes: 0 passed (or passed with warnings), 2 a required check failed / refused, 3 tool error.`;

/**
 * Command entry (plan §6.1 contract).
 * @param {string[]} argv
 * @param {{stdout?, env?, clients?, modules?, configDir?, root?}} [io] the extra fields are for unit tests:
 *   fake clients (every key given, so nothing real is built), service modules, a temporary root
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const env = io.env ?? process.env;
  const root = io.root ?? REPO_ROOT;
  const { values, positionals } = parseCommandArgs(argv, {
    subject: { type: 'string', multiple: true, default: [] },
    set: { type: 'string', multiple: true, default: [] },
    json: { type: 'boolean', default: false },
    out: { type: 'string' },
    'modules-root': { type: 'string' },
  });
  if (values.help) {
    stdout.write(`${description}\n\n${usage}\n`);
    return EXIT.OK;
  }
  if (positionals.length !== 1)
    throw new UsageError('preflight needs exactly one environment name');

  // Prod is refused inside loadEnvironment, before anything connects.
  const environment = loadEnvironment(
    positionals[0],
    io.configDir ? { configDir: io.configDir } : {},
  );
  // No subject/test type needed: preflight reads values only (plan §3.3).
  const settings = resolveSettings({ environment, overrides: parseSetArgs(values.set), env });
  const result = await runPreflight({
    environment,
    subjects: values.subject,
    settings,
    // Keys left out are built from the environment (and closed) by tools/preflight/clients.mjs.
    clients: { env, ...(io.clients ?? {}) },
    modules: io.modules ?? null,
    modulesRoot: values['modules-root'] ? path.resolve(values['modules-root']) : undefined,
    resultsRoot: path.join(root, 'results'),
    testDataRoot: path.join(root, 'test-data'),
  });
  if (values.out) {
    const file = path.resolve(values.out);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  }
  stdout.write(`${values.json ? JSON.stringify(result, null, 2) : formatPreflightTable(result)}\n`);
  for (const warning of settings.warnings) stdout.write(`settings: ${warning}\n`);
  return result.status === 'failed' ? EXIT.REFUSED : EXIT.OK;
}
