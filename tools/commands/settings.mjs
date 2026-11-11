/**
 * settings.mjs — CLI command `settings`: print the resolved settings (and phase plan) without running.
 *
 * What:    Shows exactly what a run would use: every relevant setting with its value, where the value
 *          came from (default, environment file, environment variable, --set, derived) and whether it is
 *          still "to be confirmed", then the phase plan (warm-up, measured phase, levels, planned events).
 *          Without a subject it prints the values only (no phase plan), e.g. for cleanup settings.
 *          Never opens a network connection (D14): only config/ and test-data/ files are read.
 * How:     node tools/cli.mjs settings local collector load --set LOAD_EVENTS=1000
 *          node tools/cli.mjs settings local                       (values only)
 *          scripts/print-settings.sh local matcher stress --json
 * Needs:   config/environments/<env>.json, config/settings/defaults.json, the service module of the
 *          subject (--modules-root to look elsewhere, e.g. tools/core/unit-tests/fixtures for the stub).
 * Outputs: The settings table (+ phase plan) on stdout, or with --json: { environment, subject, testType,
 *          settings: { NAME: { value, source } }, derived, warnings }. Exit 0, 2 when refused.
 */
import path from 'node:path';
import { parseCommandArgs } from '../core/command-args.mjs';
import { loadEnvironment } from '../core/environment.mjs';
import { EXIT, UsageError } from '../core/errors.mjs';
import { REPO_ROOT } from '../core/paths.mjs';
import { prepareRunSettings } from '../core/run-setup.mjs';
import { getServiceModule } from '../core/service-registry.mjs';
import { parseSetArgs, printSettings, settingsForResult } from '../core/settings.mjs';

export const description = 'Print the resolved settings and phase plan of a test (no connections)';
export const usage = `Usage: settings <env> [<subject> <test-type>] [--set NAME=value]… [--json] [--all-settings] [--modules-root <dir>]

  <env>               environment name (config/environments/<env>.json), e.g. local
  <subject>           collector | matcher | step-sla (or a service folder name); omit for values only
  <test-type>         smoke | load | stress | breakpoint
  --set NAME=value    override a setting (repeatable), e.g. --set LOAD_EVENTS=1000
  --json              print JSON: { environment, subject, testType, settings: { NAME: { value, source } },
                      derived, warnings }
  --all-settings      print every setting, not only those relevant to this test
  --modules-root <d>  folder holding the service folders (default: repository root)

Example: settings local collector load --set LOAD_EVENTS=1000   → LOAD_DURATION 20s (derived; = events / LOAD_RATE)`;

/**
 * Command entry (plan §6.1).
 * @param {string[]} argv arguments after "settings"
 * @param {{stdout?:{write(s:string):void}, cwd?:string}} [io]
 * @param {{env?:object, configDir?:string, now?:Date}} [deps] injected by unit tests
 * @returns {Promise<number>}
 */
export async function main(argv, io = {}, deps = {}) {
  const stdout = io.stdout ?? process.stdout;
  const cwd = io.cwd ?? process.cwd();
  const { values, positionals } = parseCommandArgs(argv, {
    set: { type: 'string', multiple: true, default: [] },
    json: { type: 'boolean', default: false },
    'all-settings': { type: 'boolean', default: false },
    'modules-root': { type: 'string' },
  });
  if (positionals.length !== 1 && positionals.length !== 3) {
    throw new UsageError('settings needs <env>, or <env> <subject> <test-type>');
  }
  const [envName, subject, testType] = positionals;
  const environment = loadEnvironment(envName, deps.configDir ? { configDir: deps.configDir } : {});
  const modulesRoot = values['modules-root']
    ? path.resolve(cwd, values['modules-root'])
    : REPO_ROOT;
  const module = subject ? await getServiceModule(subject, { root: modulesRoot }) : null;
  if (module && !module.testTypes.includes(testType)) {
    throw new UsageError(
      `${module.subject} has no ${testType} test (it has: ${module.testTypes.join(', ')})`,
    );
  }
  const { resolved } = await prepareRunSettings({
    environment,
    module,
    testType: testType ?? null,
    overrides: parseSetArgs(values.set),
    env: deps.env ?? process.env,
    now: deps.now ?? new Date(),
  });

  if (values.json) {
    stdout.write(
      `${JSON.stringify(
        {
          environment: environment.name,
          subject: module?.subject ?? null,
          testType: testType ?? null,
          settings: settingsForResult(resolved),
          derived: resolved.derived,
          warnings: resolved.warnings,
        },
        null,
        2,
      )}\n`,
    );
    return EXIT.OK;
  }
  const what = module ? `${module.subject} ${testType}` : '(no subject: values only)';
  stdout.write(`Settings for ${environment.name} ${what}\n\n`);
  // Without a subject every setting is shown, and there is no phase plan (plan §6.1).
  stdout.write(
    `${printSettings(resolved, {
      onlyRelevant: Boolean(module) && !values['all-settings'],
      includePhasePlan: Boolean(module),
    })}\n`,
  );
  return EXIT.OK;
}
