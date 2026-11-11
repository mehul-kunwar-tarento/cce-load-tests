/**
 * baseline.mjs — CLI command `baseline`: save, compare, list and show baselines (plan §8.3).
 *
 * What:    `save` turns at least BASELINE_MIN_RUNS (3) runs per test into baselines/<name>.json (refused
 *          when runs differ in conditions, when the name exists without --force, or with too few runs
 *          unless --allow-fewer → provisional). `compare` compares runs with a baseline and writes
 *          baseline-comparison.json into each compared run folder (informational: statuses never change).
 *          `list` shows saved baselines; `show` prints one. Everything is read from result.json files.
 * How:     node tools/cli.mjs baseline save local-emr-service results/a results/b results/c [--note "…"]
 *          node tools/cli.mjs baseline compare local-emr-service results/d
 *          node tools/cli.mjs baseline list   |   baseline show local-emr-service
 *          scripts/manage-baselines.sh list
 * Needs:   result folders; service modules for their baselineMetrics (--modules-root to look elsewhere).
 * Outputs: baselines/<name>.json, <run>/baseline-comparison.json, tables on stdout. Exit 0, 2 refused.
 */
import path from 'node:path';
import { parseCommandArgs } from '../core/command-args.mjs';
import { EXIT, RefusedError, UsageError } from '../core/errors.mjs';
import { NOT_AVAILABLE, formatNumber, markdownTable } from '../core/format.mjs';
import { readJson, writeGeneratedJson } from '../core/results.mjs';
import { loadSettingDefinitions } from '../core/settings.mjs';
import { compareWithBaseline } from '../baseline/baseline-compare.mjs';
import { createMetricsFor } from '../baseline/baseline-metrics.mjs';
import {
  DEFAULT_BASELINES_DIR,
  listBaselines,
  loadBaseline,
  saveBaseline,
} from '../baseline/baseline-store.mjs';
import { renderBaselineSection } from '../report/run-report.mjs';
import fs from 'node:fs';

export const description = 'Save, compare, list or show baselines (key metrics over several runs)';
export const usage = `Usage: baseline save <name> <resultDir>… [--note <text>] [--force] [--allow-fewer]
       baseline compare <name> <resultDir>…
       baseline list
       baseline show <name>
  Options: --modules-root <dir> (service folders), --tolerance <percent> (default BASELINE_TOLERANCE),
           --min-runs <n> (default BASELINE_MIN_RUNS)

  save     needs >= BASELINE_MIN_RUNS (3) passed/failed runs per test, all under the same conditions;
           --allow-fewer saves a PROVISIONAL baseline; --force replaces an existing one.
  compare  writes baseline-comparison.json into each run folder (never changes a run's status).`;

/** Default of a numeric setting from defaults.json; why: tolerance and min runs are settings (§3.2). */
function settingDefault(name) {
  return Number(loadSettingDefinitions()[name]?.default);
}

/**
 * Reads the result.json of each given folder.
 * Why: baselines are built from JSON only; a folder without result.json is refused by name.
 * @param {string[]} dirs absolute folders
 */
function readRuns(dirs) {
  return dirs.map((dir) => {
    const file = path.join(dir, 'result.json');
    if (!fs.existsSync(file)) throw new RefusedError(`${dir} has no result.json`);
    return { dir, result: readJson(file) };
  });
}

/**
 * Command entry (plan §6.1).
 * @param {string[]} argv
 * @param {{stdout?:{write(s:string):void}, stderr?:{write(s:string):void}, cwd?:string}} [io]
 * @param {{baselinesDir?:string, modules?:object[], now?:Date, env?:object}} [deps] injected by unit tests
 * @returns {Promise<number>}
 */
export async function main(argv, io = {}, deps = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const { values, positionals } = parseCommandArgs(argv, {
    note: { type: 'string', default: '' },
    force: { type: 'boolean', default: false },
    'allow-fewer': { type: 'boolean', default: false },
    'modules-root': { type: 'string' },
    tolerance: { type: 'string' },
    'min-runs': { type: 'string' },
  });
  const [action, name, ...dirArgs] = positionals;
  const baselinesDir = deps.baselinesDir ?? DEFAULT_BASELINES_DIR;
  const modulesRoot = values['modules-root']
    ? path.resolve(cwd, values['modules-root'])
    : undefined;
  // Settings may come from the environment like everywhere else (BASELINE_TOLERANCE=10 …).
  const tolerance = Number(
    values.tolerance ?? env.BASELINE_TOLERANCE ?? settingDefault('BASELINE_TOLERANCE'),
  );
  const minRuns = Number(
    values['min-runs'] ?? env.BASELINE_MIN_RUNS ?? settingDefault('BASELINE_MIN_RUNS'),
  );
  if (!Number.isFinite(tolerance) || tolerance < 0)
    throw new UsageError('--tolerance needs a number ≥ 0');
  if (!Number.isInteger(minRuns) || minRuns < 1)
    throw new UsageError('--min-runs needs a whole number ≥ 1');

  if (action === 'list') {
    const rows = listBaselines({ baselinesDir }).map((b) => [
      b.name,
      b.savedAt,
      b.environment ?? NOT_AVAILABLE,
      b.planDefinitionSet ?? NOT_AVAILABLE,
      b.runs,
      b.provisional ? 'yes' : 'no',
      b.note,
    ]);
    stdout.write(
      rows.length
        ? `${markdownTable(['Baseline', 'Saved', 'Environment', 'Plan-definition set', 'Runs', 'Provisional', 'Note'], rows)}\n`
        : 'No baselines yet: node tools/cli.mjs baseline save <name> <result folders>\n',
    );
    return EXIT.OK;
  }
  if (action === 'show') {
    if (!name) throw new UsageError('baseline show needs a name');
    const baseline = loadBaseline(name, { baselinesDir });
    const rows = Object.entries(baseline.metrics ?? {}).map(([key, m]) => [
      m.label ?? key,
      m.unit,
      formatNumber(m.mean),
      `${formatNumber(m.min)}–${formatNumber(m.max)}`,
      formatNumber(m.stddev),
      m.runs,
      m.better,
    ]);
    stdout.write(
      `Baseline ${baseline.name}${baseline.provisional ? ' (PROVISIONAL)' : ''}, saved ${baseline.savedAt}` +
        `, environment ${baseline.conditions?.environment}, set ${baseline.conditions?.planDefinitionSet?.name}\n\n` +
        `${markdownTable(['Metric', 'Unit', 'Mean', 'Range', 'Std dev', 'Runs', 'Better'], rows)}\n`,
    );
    return EXIT.OK;
  }
  if (action !== 'save' && action !== 'compare')
    throw new UsageError('baseline needs save, compare, list or show');
  if (!name || !dirArgs.length)
    throw new UsageError(`baseline ${action} needs a name and result folders`);

  const runs = readRuns(dirArgs.map((dir) => path.resolve(cwd, dir)));
  const warnings = [];
  const metricsFor = await createMetricsFor({
    results: runs.map((r) => r.result),
    modulesRoot,
    warnings,
    modules: deps.modules ?? null,
  });

  if (action === 'save') {
    const saved = saveBaseline({
      name,
      runs,
      metricsFor,
      minRuns,
      allowFewer: values['allow-fewer'],
      force: values.force,
      note: values.note,
      baselinesDir,
      now: deps.now ?? new Date(),
    });
    for (const warning of [...warnings, ...saved.warnings]) stderr.write(`WARNING: ${warning}\n`);
    stdout.write(
      `Saved baseline ${name}${saved.baseline.provisional ? ' (PROVISIONAL)' : ''} with ${Object.keys(saved.baseline.metrics).length} metric(s) from ${runs.length} run(s): ${saved.file}\n`,
    );
    return EXIT.OK;
  }

  const baseline = loadBaseline(name, { baselinesDir });
  const comparison = compareWithBaseline({
    baseline,
    results: runs.map((r) => r.result),
    metricsFor,
    tolerance,
    now: deps.now ?? new Date(),
  });
  const { $comment, ...body } = comparison;
  for (const { dir } of runs)
    writeGeneratedJson(path.join(dir, 'baseline-comparison.json'), $comment, body);
  for (const warning of warnings) stderr.write(`WARNING: ${warning}\n`);
  stdout.write(`${renderBaselineSection(body).join('\n')}\n`);
  stdout.write(
    `\nWritten: baseline-comparison.json in ${runs.length} run folder(s). Re-render a report with: node tools/cli.mjs report <dir>\n`,
  );
  return EXIT.OK;
}
