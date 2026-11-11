/**
 * report.mjs — CLI command `report`: the run report of one result folder, or a series summary.
 *
 * What:    `report <resultDir>` re-renders report.md from that run's result.json (validated first) and
 *          prints it — useful after `check-data` or when the report format improves. With `--series`
 *          (folders), `--latest <n>` or `--since <yyyy-mm-dd>` it writes summary.json + summary.md over
 *          several runs: per service (load, stress, breaking points) and then the whole flow (plan §8.2).
 *          Only result.json files are read (and baseline-comparison.json when present); never logs or
 *          Markdown. Folders without result.json (v1 outputs) are ignored.
 * How:     node tools/cli.mjs report results/collector-load-20261105-142233
 *          node tools/cli.mjs report --series results/collector-load-… results/matcher-stress-… [--out <dir>]
 *          node tools/cli.mjs report --latest 6        |   --since 2026-11-05
 *          scripts/build-report.sh --latest 6
 * Needs:   result folders under results/ (or given paths).
 * Outputs: report.md (single) or <out>/summary.json + summary.md (series; default
 *          results/summary-<yyyymmdd-hhmmss>/); the Markdown on stdout. Exit 0, 2 when refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCommandArgs } from '../core/command-args.mjs';
import { EXIT, RefusedError, UsageError } from '../core/errors.mjs';
import { formatStamp } from '../core/format.mjs';
import { FOLDERS, REPO_ROOT, repoPath } from '../core/paths.mjs';
import { validateResult } from '../core/result-schema.mjs';
import { findResultDirs, readJson, readJsonIfExists } from '../core/results.mjs';
import { renderRunReport } from '../report/run-report.mjs';
import { writeSeriesReport } from '../report/series-report.mjs';

export const description =
  'Render the run report of a result folder, or a series summary of several runs';
export const usage = `Usage: report <resultDir>
       report --series <resultDir>… [--out <dir>]
       report --latest <n> | --since <yyyy-mm-dd> [--subject <s>] [--out <dir>]

  <resultDir>         a run folder with result.json (results/<subject>-<type>-<yyyymmdd-hhmmss>)
  --series            summarise the given folders (per service, then the whole flow)
  --latest <n>        summarise the newest n runs in results/
  --since <date>      summarise every run since that date (yyyy-mm-dd)
  --subject <s>       with --latest/--since: only this subject
  --out <dir>         where summary.json and summary.md go (default results/summary-<yyyymmdd-hhmmss>)
  --quiet             write the files without printing the Markdown`;

/**
 * Renders and writes the report of one run folder.
 * Why: also used by `run` and `check-data` so every report.md comes from the same code.
 * @param {string} dir
 * @returns {{markdown:string, file:string}}
 */
export function writeRunReport(dir) {
  const file = path.join(dir, 'result.json');
  if (!fs.existsSync(file)) {
    throw new RefusedError(
      `${dir} has no result.json (old v1 folders and cleanup folders cannot be reported)`,
    );
  }
  const result = readJson(file);
  const problems = validateResult(result);
  if (problems.length) {
    throw new RefusedError(
      `${file} is not a valid result (schema 1.0.0):\n  - ${problems.join('\n  - ')}`,
    );
  }
  // A comparison made later by `baseline compare` lives next to the result (JSON, never Markdown).
  const comparison = readJsonIfExists(path.join(dir, 'baseline-comparison.json'));
  const markdown = renderRunReport(result, { baselineComparison: comparison });
  const reportFile = path.join(dir, 'report.md');
  fs.writeFileSync(reportFile, markdown);
  return { markdown, file: reportFile };
}

/**
 * Command entry (plan §6.1).
 * @param {string[]} argv
 * @param {{stdout?:{write(s:string):void}, cwd?:string}} [io]
 * @param {{resultsRoot?:string, now?:Date}} [deps] injected by unit tests
 * @returns {Promise<number>}
 */
export async function main(argv, io = {}, deps = {}) {
  const stdout = io.stdout ?? process.stdout;
  const cwd = io.cwd ?? process.cwd();
  const { values, positionals } = parseCommandArgs(argv, {
    series: { type: 'boolean', default: false },
    latest: { type: 'string' },
    since: { type: 'string' },
    subject: { type: 'string' },
    out: { type: 'string' },
    quiet: { type: 'boolean', default: false },
  });
  const resultsRoot = deps.resultsRoot ?? repoPath(FOLDERS.results);
  const isSeries = values.series || values.latest !== undefined || values.since !== undefined;

  if (!isSeries) {
    if (positionals.length !== 1)
      throw new UsageError('report needs one result folder (or --series/--latest/--since)');
    const { markdown, file } = writeRunReport(path.resolve(cwd, positionals[0]));
    if (!values.quiet) stdout.write(markdown);
    stdout.write(`\nReport written to ${file}\n`);
    return EXIT.OK;
  }

  let dirs;
  if (values.series) {
    if (!positionals.length) throw new UsageError('report --series needs result folders');
    dirs = positionals.map((dir) => path.resolve(cwd, dir));
  } else {
    if (positionals.length)
      throw new UsageError('give folders with --series, or use --latest/--since without folders');
    const latest = values.latest !== undefined ? Number(values.latest) : undefined;
    if (latest !== undefined && !(Number.isInteger(latest) && latest > 0))
      throw new UsageError('--latest needs a whole number > 0');
    if (values.since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.since))
      throw new UsageError('--since needs yyyy-mm-dd');
    dirs = findResultDirs({
      root: resultsRoot,
      latest,
      since: values.since,
      subject: values.subject,
    });
    if (!dirs.length)
      throw new RefusedError(`No result folders with result.json found in ${resultsRoot}`);
  }
  const out = values.out
    ? path.resolve(cwd, values.out)
    : path.join(resultsRoot, `summary-${formatStamp(deps.now ?? new Date())}`);
  const { markdown, files } = writeSeriesReport({
    dirs,
    out,
    root: REPO_ROOT,
    now: deps.now ?? new Date(),
  });
  if (!values.quiet) stdout.write(markdown);
  stdout.write(`\nSeries summary written to ${files.json} and ${files.markdown}\n`);
  return EXIT.OK;
}
