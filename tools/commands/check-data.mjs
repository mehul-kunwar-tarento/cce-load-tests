/**
 * check-data.mjs — CLI command `check-data`: re-runs the data checks of a finished run.
 *
 * What:    Data checks compare what was sent with what the services stored and processed (e.g. "every
 *          accepted event is in inbound_event_log", "enrolments = fan-out × patients"). They sometimes need
 *          to be repeated: the database was slow, the matcher finished draining later, or a check was
 *          fixed. This command rebuilds the run's ctx from its run-context.json and result.json, runs the
 *          service module's dataChecks again, rewrites data-checks.json, updates result.json (data checks,
 *          "what broke", status unless the run was aborted or errored) and re-renders report.md.
 *          Run it BEFORE cleanup: after cleanup the run's rows are gone.
 * How:     node tools/cli.mjs check-data local results/matcher-stress-20261105-142233
 * Needs:   The run folder (run-context.json + result.json), the environment, DB_PASSWORD, the service folder
 *          of the run's subject (--modules-root to look elsewhere).
 * Outputs: data-checks.json, result.json, report.md (rewritten); exit 0 passed, 1 failed, 2 refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCommandArgs } from '../core/command-args.mjs';
import { createLogger } from '../core/logger.mjs';
import { loadEnvironment } from '../core/environment.mjs';
import { EXIT, RefusedError, UsageError } from '../core/errors.mjs';
import { formatNumber, toIsoWithOffset } from '../core/format.mjs';
import { createTimes } from '../core/k6-clock.mjs';
import { REPO_ROOT } from '../core/paths.mjs';
import { computeStatus } from '../core/result-builder.mjs';
import { validateResult } from '../core/result-schema.mjs';
import { readJson, writeJson } from '../core/results.mjs';
import { createRunClients } from '../core/run-clients.mjs';
import { testDataPrefix } from '../core/run-id.mjs';
import { computeSetContext, loadSetForRun } from '../core/run-setup.mjs';
import { getServiceModule } from '../core/service-registry.mjs';
import { writeRunReport } from './report.mjs';

export const description =
  "Re-run a finished run's data checks and update its result.json and report";
export const usage = `Usage: check-data <env> <resultDir> [--modules-root <dir>]

  <env>         the environment the run used (refused when it differs from the run's)
  <resultDir>   results/<subject>-<test-type>-<yyyymmdd-hhmmss> (needs run-context.json and result.json)
Run it before cleanup: cleanup deletes the rows the checks count.`;

/**
 * Updates a result with new data checks: list, "what broke" entries, status (plan §5.2 rules).
 * Why: exported for unit tests; an aborted or errored run keeps its status (data checks do not undo that).
 * @param {object} result
 * @param {object[]} dataChecks
 * @param {Date} now
 * @returns {object} the same result, changed
 */
export function applyDataChecks(result, dataChecks, now) {
  result.dataChecks = dataChecks;
  const breaking = result.breaking;
  breaking.whatBroke = (breaking.whatBroke ?? []).filter((item) => item.source !== 'data-check');
  for (const check of dataChecks) {
    if (check.passed === false && check.severity !== 'info') {
      breaking.whatBroke.push({
        metric: check.id,
        description: `${check.description}: expected ${formatNumber(check.expected)}, got ${formatNumber(check.actual)}`,
        actual: check.actual,
        limit: check.expected,
        source: 'data-check',
      });
    }
  }
  breaking.broke =
    breaking.startedBreakingAt !== null ||
    breaking.whatBroke.some((w) => w.source !== 'service-metrics');
  if (!['aborted', 'error'].includes(result.status)) {
    const verdict = computeStatus({ thresholds: result.thresholds, dataChecks, breaking });
    result.status = verdict.status;
    result.statusReason = verdict.statusReason;
  }
  result.notes = [
    ...(result.notes ?? []),
    `Data checks re-run at ${toIsoWithOffset(now)} (check-data).`,
  ];
  return result;
}

/**
 * Command entry (plan §6.1).
 * @param {string[]} argv
 * @param {{stdout?:{write(s:string):void}, stderr?:{write(s:string):void}, cwd?:string}} [io]
 * @param {{env?:object, now?:()=>Date, createRunClients?:Function, configDir?:string}} [deps] fakes for unit tests
 * @returns {Promise<number>}
 */
export async function main(argv, io = {}, deps = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const { values, positionals } = parseCommandArgs(argv, { 'modules-root': { type: 'string' } });
  if (positionals.length !== 2) throw new UsageError('check-data needs <env> <resultDir>');
  const [envName, dirArg] = positionals;
  const dir = path.resolve(cwd, dirArg);
  for (const file of ['run-context.json', 'result.json']) {
    if (!fs.existsSync(path.join(dir, file)))
      throw new RefusedError(`${dir} has no ${file}: not a run folder of this tool`);
  }
  const environment = loadEnvironment(envName, deps.configDir ? { configDir: deps.configDir } : {});
  const context = readJson(path.join(dir, 'run-context.json'));
  const result = readJson(path.join(dir, 'result.json'));
  if (context.environment?.name && context.environment.name !== environment.name) {
    throw new RefusedError(
      `That run used environment ${context.environment.name}, not ${environment.name}`,
    );
  }
  const modulesRoot = values['modules-root']
    ? path.resolve(cwd, values['modules-root'])
    : REPO_ROOT;
  const module = await getServiceModule(context.subject, { root: modulesRoot });
  const log = createLogger('check-data', { stdout, stderr });

  // The set's expected rows (data checks compare with them), from files only.
  const settings = context.settings;
  const warnings = [];
  const set = await loadSetForRun(settings.PLAN_DEFINITION_SET, {
    versionSuffix: settings.PLAN_DEFINITION_VERSION_SUFFIX ?? '',
    warnings,
  });
  const setContext = await computeSetContext(
    set,
    settings.EVENT_ACTION_ID ?? context.dataset?.defaultActionId ?? null,
    warnings,
  );
  for (const warning of warnings) log.warn(warning);

  const clients = await (deps.createRunClients ?? createRunClients)({
    environment,
    module,
    env,
    logger: log,
  });
  try {
    // The run's times come from its result (already re-based on the authoritative k6 start).
    const times = createTimes();
    Object.assign(times, {
      k6StartedAt: result.timing?.k6StartedAt ?? null,
      measureStart: result.timing?.measureStart ?? null,
      sendEnd: result.timing?.sendEnd ?? null,
      sendEndedEarly: Boolean(result.timing?.sendEndedEarly),
      source: result.timing?.source ?? null,
    });
    times.markReady();
    const prefix = testDataPrefix(context.runId);
    const ctx = {
      environment,
      settings,
      phasePlan: context.phasePlan,
      runId: context.runId,
      prefix,
      selector: `${prefix}${module.idCode}-`,
      resultsDir: dir,
      context,
      pgPool: clients.pgPool,
      kafkaAdmin: clients.kafkaAdmin,
      scrape: clients.scrape,
      logger: log.child(module.subject),
      times,
      result,
      planDefinitionSet: {
        ...(set ?? {}),
        ...(result.conditions?.planDefinitionSet ?? {}),
        expectedRows: setContext?.expectedRows ?? null,
      },
      writeJson: (name, value) => writeJson(path.join(dir, name), value),
      abortLoad: () => {},
    };
    log.info(
      `re-running the data checks of ${module.subject} ${context.testType} ${context.runId} …`,
    );
    const dataChecks = await module.dataChecks(ctx);
    writeJson(path.join(dir, 'data-checks.json'), { checks: dataChecks });
    applyDataChecks(result, dataChecks, now());
    const problems = validateResult(result);
    if (problems.length)
      throw new Error(`updated result.json would be invalid: ${problems.join('; ')}`);
    writeJson(path.join(dir, 'result.json'), result);
    const { markdown } = writeRunReport(dir);
    stdout.write(`\n${markdown}`);
    return result.status === 'passed'
      ? EXIT.OK
      : result.status === 'error'
        ? EXIT.TOOL_ERROR
        : EXIT.FAILED;
  } finally {
    await clients.close();
  }
}
