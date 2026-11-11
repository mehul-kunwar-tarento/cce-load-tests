/**
 * run-test.mjs — CLI command `run`: runs ONE performance test from start to report (plan §6.2).
 *
 * What:    The whole life of a test run, in order:
 *            1 environment (prod refused) and the service module of the subject
 *            2 settings + phase plan (printed), results folder, run-context.json, docker command
 *              (--dry-run stops here: nothing is written, started or connected)
 *            3 preflight (A3) → preflight.json; a required failure stops the run (exit 2)
 *            4 conditions: host, git commit (read-only), data volume, plan-definition snapshot
 *            5 wait until the service is idle (module.waitForIdle)
 *            6 prepare (module.prepare; Step SLA seeds alarms and returns the ring times)
 *            7 metrics sampler + watchers + Grafana "start" annotation
 *            8 k6 in Docker with the k6 clock (REST API) — or, for seeded tests, wait for the last alarm
 *            9 watchers run on until caught up / limit; sampler stops
 *           10 data checks → data-checks.json
 *           11 result.json (validated) → report.md (printed)
 *           12 optional baseline comparison (BASELINE=<name>) → baseline-comparison.json
 *          Ctrl-C (or a watcher calling ctx.abortLoad) stops k6 with SIGINT so k6 still writes its summary;
 *          the run then finishes steps 9–11 with status "aborted".
 * How:     node tools/cli.mjs run local collector load [--set LOAD_RATE=100]… [--dry-run]
 *          node tools/cli.mjs run local collector breakpoint --refine-from results/collector-breakpoint-…
 *          scripts/run-test.sh local matcher stress           (keeps the laptop awake)
 * Needs:   config/environments/<env>.json, the service folder (--modules-root to look elsewhere), Docker
 *          and the k6 image for k6 tests, DB_PASSWORD for database checks, a running CCE stack.
 * Outputs: results/<subject>-<test-type>-<yyyymmdd-hhmmss>/ (run-context.json, preflight.json, k6.log,
 *          k6-summary.json, watch-*.json, service-metrics.json, data-checks.json, result.json, report.md);
 *          exit 0 passed, 1 failed/aborted, 2 refused, 3 tool error (plan §5.7).
 */
import path from 'node:path';
import { parseCommandArgs } from '../core/command-args.mjs';
import { createAnnotator } from '../core/clients/grafana.mjs';
import { captureConditions } from '../core/conditions.mjs';
import { loadEnvironment } from '../core/environment.mjs';
import { EXIT, RefusedError, UsageError } from '../core/errors.mjs';
import { formatStamp, toIsoWithOffset } from '../core/format.mjs';
import { createTimes, setTimesFromStart, startK6Clock } from '../core/k6-clock.mjs';
import {
  buildDockerArgs,
  findFreePort,
  formatDockerCommand,
  runK6,
  stopK6,
  toContainerPath,
} from '../core/k6-runner.mjs';
import { createLogger } from '../core/logger.mjs';
import { startMetricsSampler } from '../core/metrics-sampler.mjs';
import { FOLDERS, REPO_ROOT, repoPath, toRepoRelative } from '../core/paths.mjs';
import { buildResult } from '../core/result-builder.mjs';
import { validateResult } from '../core/result-schema.mjs';
import {
  createResultsDir,
  readJson,
  readJsonIfExists,
  writeGeneratedJson,
  writeJson,
} from '../core/results.mjs';
import { createRunClients, metricsUrl } from '../core/run-clients.mjs';
import { testDataPrefix } from '../core/run-id.mjs';
import { buildRunContext, importOptional, prepareRunSettings } from '../core/run-setup.mjs';
import { COMMON_SAMPLED_METRICS } from '../core/sampled-metrics.mjs';
import { getServiceModule } from '../core/service-registry.mjs';
import { formatPhasePlan, parseSetArgs, printSettings } from '../core/settings.mjs';
import { refineFromResult } from '../core/staircase.mjs';
import { startWatchers } from '../core/watchers.mjs';
import { compareWithBaseline } from '../baseline/baseline-compare.mjs';
import { createMetricsFor } from '../baseline/baseline-metrics.mjs';
import { loadBaseline } from '../baseline/baseline-store.mjs';
import { renderRunReport } from '../report/run-report.mjs';
import fs from 'node:fs';

export const description =
  'Run one test: preflight, load (k6 or seeding), watchers, data checks, result.json and report';
export const usage = `Usage: run <env> <subject> <test-type> [--set NAME=value]… [--refine-from <resultDir>] [--dry-run]
           [--all-settings] [--modules-root <dir>]

  <env>                 environment (config/environments/<env>.json), e.g. local; prod is always refused
  <subject>             collector | matcher | step-sla (or the service folder name)
  <test-type>           smoke | load | stress | breakpoint
  --set NAME=value      override a setting for this run (repeatable); see config/settings/defaults.json
  --refine-from <dir>   breakpoint only: finer levels between that run's "held" and "broke" rates,
                        warming up at the held rate (sets LEVELS and WARM_UP_RATE unless you set them)
  --dry-run             print settings, phase plan and the docker command, then stop (no connections)
  --all-settings        print every setting, not only those relevant to this test
  --modules-root <dir>  folder holding the service folders (default: repository root)

Exit codes: 0 passed, 1 failed or aborted, 2 refused (prod, preflight, idle timeout, bad settings), 3 tool error.`;

/**
 * Real implementations of everything a run does to the outside world; unit tests replace them.
 * Why: the lifecycle is tested end to end with fakes, so the build never starts Docker or connects (D14).
 */
function defaultDeps() {
  return {
    env: process.env,
    now: () => new Date(),
    resultsRoot: repoPath(FOLDERS.results),
    repoRoot: REPO_ROOT,
    configDir: undefined,
    uid: typeof process.getuid === 'function' ? process.getuid() : 1000,
    gid: typeof process.getgid === 'function' ? process.getgid() : 1000,
    getServiceModule,
    findFreePort,
    createRunClients,
    runPreflight: null, // null = import A3's tools/preflight/preflight.mjs lazily
    captureConditions,
    runK6,
    stopK6,
    startK6Clock,
    startMetricsSampler,
    startWatchers,
    createAnnotator,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // Registers a signal handler and returns a function that removes it.
    onSignal: (signal, handler) => {
      process.on(signal, handler);
      return () => process.off(signal, handler);
    },
  };
}

/**
 * Reads --refine-from: LEVELS and WARM_UP_RATE from a previous breakpoint result (plan §6.2).
 * Why: a refined staircase starts warm at the last good level (D11) instead of cold (v1 bug). The values
 *      go to the settings as "refinements" (source "refine-from", shown in the printout and saved with
 *      the result); the tester's own --set or environment variable still wins.
 * @returns {{refinedFrom: object|null, refinements: Record<string, unknown>}}
 */
function readRefineFrom({ dir, cwd, testType }) {
  if (!dir) return { refinedFrom: null, refinements: {} };
  if (testType !== 'breakpoint')
    throw new UsageError('--refine-from works only for breakpoint tests');
  const file = path.join(path.resolve(cwd, dir), 'result.json');
  if (!fs.existsSync(file)) throw new RefusedError(`--refine-from: ${file} does not exist`);
  const refine = refineFromResult(readJson(file));
  return {
    refinedFrom: refine.refinedFrom,
    refinements: { LEVELS: refine.LEVELS, WARM_UP_RATE: refine.WARM_UP_RATE },
  };
}

/**
 * The lines printed before every run (plan §3.4).
 * Why: the tester sees everything in force before anything starts; the same text in a dry run.
 */
function startBanner({
  environment,
  module,
  testType,
  context,
  resultsRel,
  setup,
  dockerLine,
  allSettings,
  dryRun,
}) {
  const set = setup.planDefinitionSet;
  const lines = [
    `${dryRun ? 'DRY RUN — ' : ''}${module.displayName ?? module.subject} ${testType}`,
    `  environment:          ${environment.name} (${environment.kind}, ${environment.configFile})`,
    `  service:              ${module.service} (subject ${module.subject}, ${module.kind === 'k6' ? 'k6 load' : 'seeded'})`,
    `  run id:               ${context.runId}`,
    `  results folder:       ${resultsRel}${dryRun ? ' (not created in a dry run)' : ''}`,
    `  plan-definition set:  ${set?.name ?? 'none'}${typeof set?.fanOut === 'number' ? ` (${set.fanOut} plan definition(s))` : ''}`,
    `  dataset:              ${setup.dataset?.name ?? '(not found)'}`,
    '',
    printSettings(setup.resolved, { onlyRelevant: !allSettings, includePhasePlan: false }),
    '',
    formatPhasePlan(setup.resolved.derived.phasePlan),
    '',
    dockerLine
      ? `k6 command (secrets masked):\n  ${dockerLine}`
      : 'No k6: this test is seeded (module.prepare writes the load into the database).',
  ];
  return `${lines.join('\n')}\n`;
}

/** Waits until an ISO time, or until `stop()` says so; why: seeded runs wait for the last alarm to ring. */
async function waitUntil(iso, stop, sleep, now) {
  const targetMs = iso ? new Date(iso).getTime() : NaN;
  while (Number.isFinite(targetMs) && now().getTime() < targetMs && !stop()) {
    await sleep(Math.min(1000, targetMs - now().getTime()));
  }
}

/** Exit code of a finished run (plan §5.7). */
function exitCodeOf(status) {
  if (status === 'passed') return EXIT.OK;
  if (status === 'error') return EXIT.TOOL_ERROR;
  return EXIT.FAILED;
}

/**
 * Command entry (plan §6.1).
 * @param {string[]} argv
 * @param {{stdout?:{write(s:string):void}, stderr?:{write(s:string):void}, cwd?:string}} [io]
 * @param {object} [deps] fakes for unit tests (see defaultDeps)
 * @returns {Promise<number>}
 */
export async function main(argv, io = {}, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();
  const { values: options, positionals } = parseCommandArgs(argv, {
    set: { type: 'string', multiple: true, default: [] },
    'refine-from': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'all-settings': { type: 'boolean', default: false },
    'modules-root': { type: 'string' },
  });
  if (positionals.length !== 3) throw new UsageError('run needs <env> <subject> <test-type>');
  const [envName, subject, testType] = positionals;
  const dryRun = options['dry-run'];

  // 1. Environment (prod refused) and service module.
  const environment = loadEnvironment(envName, d.configDir ? { configDir: d.configDir } : {});
  const modulesRoot = options['modules-root']
    ? path.resolve(cwd, options['modules-root'])
    : d.repoRoot;
  const module = await d.getServiceModule(subject, { root: modulesRoot });
  if (!module.testTypes.includes(testType)) {
    throw new UsageError(
      `${module.subject} has no ${testType} test (it has: ${module.testTypes.join(', ')})`,
    );
  }

  // 2. Settings, phase plan, run context, docker command.
  const overrides = parseSetArgs(options.set);
  const { refinedFrom, refinements } = readRefineFrom({
    dir: options['refine-from'],
    cwd,
    testType,
  });
  const startedAt = d.now();
  const setup = await prepareRunSettings({
    environment,
    module,
    testType,
    overrides,
    refinements,
    env: d.env,
    now: startedAt,
  });
  const values = setup.resolved.values;
  const phasePlan = setup.resolved.derived.phasePlan;
  if (module.kind === 'k6' && !setup.dataset && !dryRun) {
    throw new RefusedError(
      `DATASET ${values.DATASET} not found in test-data/datasets/: k6 tests need it`,
    );
  }
  const resultsDir = dryRun
    ? (() => {
        const dir = path.join(
          d.resultsRoot,
          `${module.subject}-${testType}-${formatStamp(startedAt)}`,
        );
        const relativeDir = toRepoRelative(dir, d.repoRoot);
        return { dir, relativeDir, dirInContainer: `/tests/${relativeDir}` };
      })()
    : createResultsDir({
        subject: module.subject,
        testType,
        startedAt,
        root: d.resultsRoot,
        repoRoot: d.repoRoot,
      });
  // A dry run opens no socket at all: the real port is picked when the run starts.
  const apiPort = dryRun ? 6565 : await d.findFreePort();
  const context = buildRunContext({
    setup,
    module,
    testType,
    environment,
    resultsDir,
    apiPort,
    startedAt,
  });
  const dockerArgs =
    module.kind === 'k6'
      ? buildDockerArgs({
          environment,
          context,
          settings: values,
          scriptPath: toContainerPath(module.testFile(testType), d.repoRoot),
          repoRoot: d.repoRoot,
          uid: d.uid,
          gid: d.gid,
        })
      : null;
  stdout.write(
    startBanner({
      environment,
      module,
      testType,
      context,
      setup,
      dryRun,
      resultsRel: resultsDir.relativeDir,
      dockerLine: dockerArgs ? formatDockerCommand(dockerArgs) : null,
      allSettings: options['all-settings'],
    }),
  );
  if (dryRun) {
    stdout.write('\nDry run: nothing was written, started or connected.\n');
    return EXIT.OK;
  }

  const dir = resultsDir.dir;
  const log = createLogger('run', { stdout, stderr });
  for (const warning of setup.resolved.warnings) log.warn(warning);
  writeJson(path.join(dir, 'run-context.json'), context);
  const clients = await d.createRunClients({ environment, module, env: d.env, logger: log });
  const removeSignal = [];
  try {
    // 3. Preflight (A3), unless SKIP_PREFLIGHT (recorded in the result).
    let preflight = null;
    if (values.SKIP_PREFLIGHT) {
      log.warn(
        'SKIP_PREFLIGHT=true: no preflight checks (recorded in the result; not recommended)',
      );
    } else {
      const preflightModule = d.runPreflight
        ? null
        : await importOptional('../preflight/preflight.mjs', 'preflight.mjs');
      const runPreflight = d.runPreflight ?? preflightModule?.runPreflight;
      if (!runPreflight) {
        throw new RefusedError(
          'tools/preflight/preflight.mjs is not installed: run with SKIP_PREFLIGHT=true to go on without it',
        );
      }
      log.info('preflight …');
      preflight = await runPreflight({
        environment,
        subjects: [module.subject],
        settings: setup.resolved,
        planDefinitionSetName: values.PLAN_DEFINITION_SET,
        clients: clients.preflightClients(),
        modules: [module],
        resultsRoot: d.resultsRoot,
      });
      writeJson(path.join(dir, 'preflight.json'), preflight);
      if (preflightModule?.formatPreflightTable)
        stdout.write(`${preflightModule.formatPreflightTable(preflight)}\n`);
      if (preflight.status === 'failed') {
        log.error(
          `preflight failed: the run did not start (see ${path.join(resultsDir.relativeDir, 'preflight.json')})`,
        );
        return EXIT.REFUSED;
      }
    }

    // 4. Conditions of the measurement.
    const warnings = [...setup.resolved.warnings];
    const otherMatches =
      preflight?.checks?.find((c) => c.id === 'plan-definition-set')?.data
        ?.otherActivePlanDefinitions ?? [];
    const conditions = await d.captureConditions({
      environment,
      settings: values,
      planDefinitionSet: setup.planDefinitionSet,
      pgPool: clients.pgPool,
      protocolApi: clients.protocolApi,
      subject: module.subject,
      otherMatches,
      warnings,
    });

    // The ctx every module hook receives (plan §6.4).
    const times = createTimes();
    let aborted = null;
    const stopLoad = () => (module.kind === 'k6' ? d.stopK6(context.runId) : Promise.resolve());
    const prefix = testDataPrefix(context.runId);
    const ctx = {
      environment,
      settings: values,
      resolved: setup.resolved,
      phasePlan,
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
      planDefinitionSet: {
        ...(setup.planDefinitionSet ?? {}),
        ...(conditions.planDefinitionSet ?? {}),
        expectedRows: setup.setContext?.expectedRows ?? null,
      },
      writeJson: (name, value) => writeJson(path.join(dir, name), value),
      /** Watchers stop the load early (stall, service restart): k6 gets SIGINT and still writes its summary. */
      abortLoad: (reason) => {
        if (aborted) return;
        aborted = reason;
        log.warn(`stopping the load: ${reason}`);
        stopLoad();
      },
    };

    // 5. Idle, 6. prepare.
    if (module.waitForIdle) {
      log.info(`waiting until ${module.subject} is idle (IDLE_TIMEOUT ${values.IDLE_TIMEOUT} s) …`);
      await module.waitForIdle(ctx);
    }
    const prep = module.prepare ? await module.prepare(ctx) : undefined;
    const prepareResult = prep && typeof prep === 'object' && prep.measureStart ? prep : null;
    if (prepareResult) {
      times.measureStart = toIsoWithOffset(new Date(prepareResult.measureStart));
      times.sendEnd = toIsoWithOffset(new Date(prepareResult.sendEnd));
      times.source = 'seed';
      times.markReady();
    }

    // 7. Sampler, watchers, Grafana start annotation, Ctrl-C.
    const targets = (module.requires?.services ?? [])
      .map((service) => ({ subject: service, url: metricsUrl(environment, service) }))
      .filter((target) => target.url);
    const sampler = targets.length
      ? d.startMetricsSampler({
          targets,
          intervalSeconds: values.WATCH_INTERVAL,
          file: path.join(dir, 'service-metrics.json'),
          metrics: [...COMMON_SAMPLED_METRICS, ...(module.sampledMetrics ?? [])],
          scrape: clients.scrapeUrl,
        })
      : null;
    const watchers = d.startWatchers(module.watchers ?? [], ctx);
    const annotator = d.createAnnotator({
      environment,
      logger: log,
      env: d.env,
      baseTags: [context.runId, module.subject, testType],
    });
    await annotator.annotate({
      time: startedAt,
      text: `${module.subject} ${testType} ${context.runId}: run started`,
    });
    removeSignal.push(
      d.onSignal('SIGINT', () => {
        if (!aborted) aborted = 'Ctrl-C';
        log.warn('Ctrl-C: stopping the load; results so far are kept (press again to force)');
        stopLoad();
        watchers.stopAll();
      }),
    );

    // 8. Load: k6 with its clock, or wait for the seeded alarms to ring.
    let k6ExitCode = null;
    let k6ExitedAt = null;
    if (module.kind === 'k6') {
      const containerStartedAtMs = d.now().getTime();
      const clock = d.startK6Clock({
        apiUrl: `http://127.0.0.1:${apiPort}`,
        phasePlan,
        times,
        containerStartedAtMs,
      });
      log.info(`k6 starting (REST API on 127.0.0.1:${apiPort}) …`);
      const k6 = await d.runK6(dockerArgs, {
        logFile: path.join(dir, 'k6.log'),
        onLine: (line) => stdout.write(`  k6 | ${line}\n`),
      });
      clock.stop();
      k6ExitCode = k6.exitCode;
      k6ExitedAt = k6.exitedAt;
      if (!times.measureStart) {
        // k6 ended before reporting "running": estimate, the summary (if any) corrects it.
        setTimesFromStart(times, phasePlan, containerStartedAtMs, 'estimated');
        times.warnings.push(
          'k6 never reported "running" on its REST API: times estimated from the container start',
        );
      }
      times.markReady();
      if (k6ExitedAt && new Date(k6ExitedAt) < new Date(times.sendEnd)) {
        times.sendEnd = k6ExitedAt;
        times.sendEndedEarly = true;
      }
      log.info(`k6 finished with exit code ${k6ExitCode}`);
    } else {
      log.info(`seeded: waiting until the last alarm rings (${times.sendEnd}) …`);
      await waitUntil(times.sendEnd, () => Boolean(aborted), d.sleep, d.now);
    }

    // 9. Watchers until caught up / limit; then stop the sampler.
    const outcomes = await watchers.whenDone();
    const watchersEndedAt = toIsoWithOffset(d.now());
    await sampler?.stop();

    // 10. Data checks (a failing module is recorded, not fatal: the load data is still worth a result).
    let dataChecks;
    try {
      dataChecks = await module.dataChecks(ctx);
    } catch (error) {
      warnings.push(`data checks could not run: ${error.message}`);
      dataChecks = [
        {
          id: `${module.subject}.data-checks-ran`,
          description: `Data checks ran (${error.message})`,
          expected: 1,
          actual: 0,
          comparison: 'equals',
          passed: false,
          severity: 'required',
        },
      ];
    }
    writeJson(path.join(dir, 'data-checks.json'), { checks: dataChecks });

    // 11. Result and report.
    const k6Summary = readJsonIfExists(path.join(dir, 'k6-summary.json'));
    const moduleEvaluation =
      (await module.evaluate?.(ctx, {
        k6Summary,
        watcherOutcomes: outcomes,
        dataChecks,
        times,
        phasePlan,
      })) ?? {};
    const expectation = module.expectation({
      testType,
      settings: values,
      environment,
      planDefinitionSet: ctx.planDefinitionSet,
    });
    const result = buildResult({
      context,
      settings: setup.resolved,
      phasePlan,
      preflight,
      preflightSkipped: Boolean(values.SKIP_PREFLIGHT),
      conditions,
      k6Summary,
      watcherOutcomes: outcomes,
      serviceMetrics: readJsonIfExists(path.join(dir, 'service-metrics.json')),
      dataChecks,
      moduleEvaluation,
      timings: {
        times,
        k6ExitedAt,
        endedAt: d.now(),
        watchersEndedAt: outcomes.length ? watchersEndedAt : null,
        prepareResult,
      },
      k6ExitCode,
      aborted,
      expectation,
      module,
      refinedFrom,
      warnings: [...warnings, ...log.warnings.filter((w) => !warnings.includes(w))],
    });
    const problems = validateResult(result);
    if (problems.length) result.warnings.push(...problems.map((p) => `result.json shape: ${p}`));

    // 12. Optional baseline comparison (informational).
    if (values.BASELINE) {
      try {
        const baseline = loadBaseline(values.BASELINE);
        const metricsFor = await createMetricsFor({
          results: [result],
          modulesRoot,
          warnings: result.warnings,
          modules: [module],
        });
        const { $comment, ...comparison } = compareWithBaseline({
          baseline,
          results: [result],
          metricsFor,
          tolerance: values.BASELINE_TOLERANCE,
        });
        writeGeneratedJson(path.join(dir, 'baseline-comparison.json'), $comment, comparison);
        result.baselineComparison = comparison;
        result.artifacts.baselineComparison = 'baseline-comparison.json';
      } catch (error) {
        result.warnings.push(`baseline ${values.BASELINE} not compared: ${error.message}`);
      }
    }
    writeJson(path.join(dir, 'result.json'), result);
    const report = renderRunReport(result);
    fs.writeFileSync(path.join(dir, 'report.md'), report);
    stdout.write(`\n${report}\nResults: ${resultsDir.relativeDir}/ (result.json, report.md)\n`);

    // Grafana: the run as a region, plus the moments people look for.
    await annotator.annotate({
      time: startedAt,
      timeEnd: result.endedAt,
      text: `${module.subject} ${testType} ${context.runId}: ${result.status}`,
    });
    if (result.timing.measureStart)
      await annotator.annotate({
        time: result.timing.measureStart,
        text: 'measured phase started',
      });
    if (result.timing.sendEnd)
      await annotator.annotate({
        time: result.timing.sendEnd,
        text: module.kind === 'k6' ? 'sending ended' : 'last alarm rang',
      });
    if (result.breaking.startedBreakingAt)
      await annotator.annotate({
        time: result.breaking.startedBreakingAt,
        text: 'started breaking',
      });
    if (result.breaking.caughtUp && result.timing.sendEnd) {
      await annotator.annotate({
        time: new Date(result.timing.sendEnd).getTime() + result.breaking.catchUpSeconds * 1000,
        text: 'caught up',
      });
    }
    return exitCodeOf(result.status);
  } finally {
    for (const remove of removeSignal) remove();
    await clients.close();
  }
}
