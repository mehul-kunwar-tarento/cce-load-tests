/**
 * baseline-store.mjs — saves, loads and lists baselines (baselines/<name>.json), plan §8.3.
 *
 * What:    A baseline is "the numbers we normally get" for some tests under known conditions (environment,
 *          machine, plan-definition set, dataset, rates and durations, data volume), saved under a name such
 *          as local-emr-service. Later runs are compared with it (baseline-compare.mjs) to see what got
 *          slower and by how much. Rules: each (service, test type) needs at least BASELINE_MIN_RUNS (3) runs
 *          that passed or failed (an "error" run has no numbers); fewer only with --allow-fewer, and the
 *          baseline is then marked provisional. All runs must share environment, plan-definition set, dataset
 *          and rate/duration settings, else saving is refused with the differences listed. A name that exists
 *          is refused unless --force. Values come from result.json only (v1 grepped Markdown).
 * How:     import { saveBaseline, loadBaseline, listBaselines } from './baseline-store.mjs';
 *          CLI: node tools/cli.mjs baseline save local-emr-service results/a results/b results/c
 * Needs:   result.json files; each service module's baselineMetrics(result) (generic metrics otherwise).
 * Outputs: baselines/<name>.json (with a generated $comment header, dropped again by the loader).
 */
import fs from 'node:fs';
import path from 'node:path';
import { RefusedError } from '../core/errors.mjs';
import { toIsoWithOffset } from '../core/format.mjs';
import { FOLDERS, REPO_ROOT, repoPath, toRepoRelative } from '../core/paths.mjs';
import { readJson, writeGeneratedJson } from '../core/results.mjs';

/** baselines/<name>.json schema version and kind (plan §8.3). */
export const BASELINE_SCHEMA_VERSION = '1.0.0';
export const BASELINE_KIND = 'cce-performance-baseline';

/** Default folder of the baselines. */
export const DEFAULT_BASELINES_DIR = repoPath(FOLDERS.baselines);

/**
 * Settings recorded in a baseline and compared between runs: rates, durations and rule limits.
 * Why: a different rate or limit makes numbers incomparable; cleanup or report settings do not.
 */
export const COMPARED_SETTINGS = [
  'PEAK_RATE',
  'EXPECTED_HEADROOM',
  'SMOKE_RATE',
  'SMOKE_DURATION',
  'LOAD_RATE',
  'LOAD_DURATION',
  'STRESS_RATE',
  'STRESS_DURATION',
  'WARM_UP_RATE',
  'WARM_UP_DURATION',
  'LEVELS',
  'LEVEL_DURATION',
  'MATCHER_FLOOD_RATE',
  'MATCHER_FLOOD_DURATION',
  'STEP_SLA_STORM_ALARMS',
  'STEP_SLA_FIRST_RING_DELAY',
  'STEP_SLA_SEED_MODE',
  'STEP_SLA_PEAK_ALARM_RATE',
  'HTTP_P95_LIMIT_MS',
  'HTTP_MAX_FAILED_RATE',
  'MIN_CHECKS_RATE',
  'MAX_DROPPED_RATE',
  'MATCHER_MAX_BACKLOG',
  'MATCHER_MAX_CATCH_UP',
  'STEP_SLA_MAX_WAIT',
  'STEP_SLA_STORM_MAX_CATCH_UP',
  'CATCH_UP_LIMIT',
  'BREAKPOINT_CATCH_UP_LIMIT',
];

/** Header written into every baseline file (plan §2.4). */
const BASELINE_COMMENT =
  'What: a saved performance baseline (mean, min, max of key metrics over several runs) and the conditions ' +
  'it was measured under. How: written by `node tools/cli.mjs baseline save <name> <result dirs>`; compared ' +
  'with `baseline compare <name> <result dirs>` or BASELINE=<name> on a run. Needs: nothing (do not edit by ' +
  'hand; save again with --force). Outputs: read by tools/baseline/baseline-compare.mjs.';

/** Baseline names: letters, digits, dot, underscore, hyphen (they become file names). */
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * Checks a baseline name.
 * Why: the name becomes a file name; anything else could escape the baselines folder.
 * @param {string} name
 */
export function validateBaselineName(name) {
  if (!NAME_PATTERN.test(String(name ?? ''))) {
    throw new RefusedError(`Baseline name "${name}" must be 1-80 letters, digits, ".", "_" or "-"`);
  }
}

/** Value of a saved setting in a result; why: conditions compare the values actually in force. */
function settingOf(result, name) {
  return result?.conditions?.settings?.[name]?.value ?? null;
}

/**
 * Generic metrics of a result when no service module is available.
 * Why: a baseline can still be saved for a subject whose module is not installed (e.g. a later adaptor).
 * @param {object} result
 * @returns {Array<{key:string, label:string, unit:string, better:'lower'|'higher', value:number|null}>}
 */
export function defaultBaselineMetrics(result) {
  const prefix = `${result.subject}.${result.testType}`;
  const metrics = [
    {
      key: `${prefix}.p95Ms`,
      label: `${result.subject} ${result.testType} p95`,
      unit: 'ms',
      better: 'lower',
      value: result.latency?.p95 ?? null,
    },
    {
      key: `${prefix}.averageRate`,
      label: `${result.subject} ${result.testType} average rate`,
      unit: `${result.load?.unit ?? 'events'}/s`,
      better: 'higher',
      value: result.load?.averageRate ?? null,
    },
  ];
  if (result.testType === 'breakpoint') {
    metrics.push(
      {
        key: `${prefix}.heldUpTo`,
        label: `${result.subject} held up to`,
        unit: 'events/s',
        better: 'higher',
        value: result.breaking?.heldUpTo ?? null,
      },
      {
        key: `${prefix}.brokeAtRate`,
        label: `${result.subject} broke at`,
        unit: 'events/s',
        better: 'higher',
        value: result.breaking?.brokeAtRate ?? null,
      },
      {
        key: `${prefix}.drainRate`,
        label: `${result.subject} drain rate`,
        unit: `${result.load?.unit ?? 'events'}/s`,
        better: 'higher',
        value: result.breaking?.drainRate ?? null,
      },
    );
  }
  metrics.push({
    key: `${prefix}.catchUpSeconds`,
    label: `${result.subject} ${result.testType} catch-up`,
    unit: 's',
    better: 'lower',
    value: result.breaking?.caughtUp === true ? result.breaking.catchUpSeconds : null,
  });
  return metrics.filter(
    (metric) => metric.value !== null || metric.key.endsWith('.catchUpSeconds'),
  );
}

/**
 * Conditions of one result in baseline form (plan §8.3 "conditions").
 * Why: the same shape is saved in the baseline and compared later.
 * @param {object} result
 */
export function conditionsOf(result) {
  const c = result.conditions ?? {};
  const set = c.planDefinitionSet;
  return {
    environment: c.environment?.name ?? null,
    host: { hostname: c.host?.hostname ?? null, cpus: c.host?.cpus ?? null },
    k6Image: c.host?.k6Image ?? null,
    planDefinitionSet: set
      ? {
          name: set.name,
          fanOut: set.fanOut ?? null,
          canonicals: (set.planDefinitions ?? []).map((pd) => pd.canonical),
        }
      : null,
    dataset: c.dataset?.name ?? settingOf(result, 'DATASET'),
    settings: Object.fromEntries(COMPARED_SETTINGS.map((name) => [name, settingOf(result, name)])),
    dataVolume: c.dataVolume
      ? { dbSizeBytes: c.dataVolume.dbSizeBytes ?? null, rows: c.dataVolume.rows ?? {} }
      : null,
    suiteCommit: c.suite?.gitCommit ?? null,
  };
}

/** Stable text of a value for equality checks; why: arrays (LEVELS) compare by content. */
function same(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Differences between the runs that must not differ inside one baseline.
 * Why: plan §8.3 — environment, plan-definition set, dataset and rate/duration settings must match.
 * @param {object[]} results
 * @returns {string[]}
 */
export function saveConditionDifferences(results) {
  const differences = [];
  const first = conditionsOf(results[0]);
  for (const result of results.slice(1)) {
    const other = conditionsOf(result);
    const where = `${result.subject} ${result.testType} ${result.runId}`;
    if (!same(first.environment, other.environment))
      differences.push(`${where}: environment ${other.environment} ≠ ${first.environment}`);
    if (!same(first.planDefinitionSet?.name, other.planDefinitionSet?.name)) {
      differences.push(
        `${where}: plan-definition set ${other.planDefinitionSet?.name} ≠ ${first.planDefinitionSet?.name}`,
      );
    }
    if (!same(first.dataset, other.dataset))
      differences.push(`${where}: dataset ${other.dataset} ≠ ${first.dataset}`);
    for (const name of COMPARED_SETTINGS) {
      if (!same(first.settings[name], other.settings[name])) {
        differences.push(
          `${where}: ${name}=${JSON.stringify(other.settings[name])} ≠ ${JSON.stringify(first.settings[name])}`,
        );
      }
    }
  }
  return differences;
}

/**
 * Mean, min, max, (population) standard deviation of numbers.
 * Why: a baseline keeps the spread so a reader sees how noisy a metric is.
 * @param {number[]} values
 */
export function statistics(values) {
  if (!values.length) return { mean: null, min: null, max: null, stddev: null };
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const round = (value) => Math.round(value * 1000) / 1000;
  return {
    mean: round(mean),
    min: Math.min(...values),
    max: Math.max(...values),
    stddev: round(Math.sqrt(variance)),
  };
}

/**
 * Collects metric values over several results.
 * Why: the same aggregation is used for the baseline itself and for "this run" in a comparison.
 * @param {object[]} results
 * @param {(result:object) => Array<{key, label, unit, better, value}>} metricsFor
 * @returns {Record<string, {label, unit, better, values:number[], notCaughtUp:number}>}
 */
export function collectMetrics(results, metricsFor) {
  const collected = {};
  for (const result of results) {
    for (const metric of metricsFor(result) ?? []) {
      const entry = (collected[metric.key] ??= {
        label: metric.label,
        unit: metric.unit,
        better: metric.better,
        values: [],
        notCaughtUp: 0,
      });
      // Never a number for a catch-up that did not happen (D19): counted separately.
      if (metric.key.endsWith('catchUpSeconds') && result.breaking?.caughtUp === false) {
        entry.notCaughtUp += 1;
      } else if (typeof metric.value === 'number' && Number.isFinite(metric.value)) {
        entry.values.push(metric.value);
      }
    }
  }
  return collected;
}

/**
 * Builds and writes a baseline.
 * @param {object} input
 * @param {string} input.name
 * @param {Array<{dir:string, result:object}>} input.runs
 * @param {(result:object) => object[]} input.metricsFor baselineMetrics of the run's module
 * @param {number} [input.minRuns] BASELINE_MIN_RUNS
 * @param {boolean} [input.allowFewer]
 * @param {boolean} [input.force]
 * @param {string} [input.note]
 * @param {string} [input.baselinesDir]
 * @param {string} [input.root] for repository-relative folder names
 * @param {Date} [input.now]
 * @returns {{baseline:object, file:string, warnings:string[]}}
 */
export function saveBaseline({
  name,
  runs,
  metricsFor,
  minRuns = 3,
  allowFewer = false,
  force = false,
  note = '',
  baselinesDir = DEFAULT_BASELINES_DIR,
  root = REPO_ROOT,
  now = new Date(),
}) {
  validateBaselineName(name);
  if (!runs.length) throw new RefusedError('baseline save needs at least one result folder');
  const file = path.join(baselinesDir, `${name}.json`);
  if (fs.existsSync(file) && !force) {
    throw new RefusedError(`Baseline ${name} exists (${file}): use --force to replace it`);
  }
  // Only runs with numbers count: "error" runs (and aborted ones) are refused by name.
  const unusable = runs.filter(({ result }) => !['passed', 'failed'].includes(result.status));
  if (unusable.length) {
    throw new RefusedError(
      `Only passed or failed runs can form a baseline; not: ${unusable.map(({ dir, result }) => `${dir} (${result.status})`).join(', ')}`,
    );
  }
  const warnings = [];
  const groups = new Map();
  for (const run of runs) {
    const key = `${run.result.subject} ${run.result.testType}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const short = [...groups].filter(([, count]) => count < minRuns);
  if (short.length && !allowFewer) {
    throw new RefusedError(
      `Each test needs at least ${minRuns} runs (BASELINE_MIN_RUNS): ${short.map(([key, count]) => `${key} has ${count}`).join(', ')}. ` +
        'Use --allow-fewer for a provisional baseline.',
    );
  }
  if (short.length)
    warnings.push(
      `provisional: ${short.map(([key, count]) => `${key} has ${count} run(s)`).join(', ')}`,
    );
  const differences = saveConditionDifferences(runs.map((run) => run.result));
  if (differences.length) {
    throw new RefusedError(
      `The runs were measured under different conditions:\n  - ${differences.join('\n  - ')}`,
    );
  }

  const collected = collectMetrics(
    runs.map((run) => run.result),
    metricsFor,
  );
  const metrics = {};
  for (const [key, entry] of Object.entries(collected)) {
    if (!entry.values.length && !entry.notCaughtUp) continue;
    metrics[key] = {
      label: entry.label,
      unit: entry.unit,
      better: entry.better,
      values: entry.values,
      ...statistics(entry.values),
      runs: entry.values.length,
      notCaughtUp: entry.notCaughtUp,
    };
    if (entry.notCaughtUp)
      warnings.push(
        `${key}: ${entry.notCaughtUp} run(s) did not catch up (no number saved for them)`,
      );
  }

  const baseline = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    kind: BASELINE_KIND,
    name,
    note,
    savedAt: toIsoWithOffset(now),
    provisional: short.length > 0,
    conditions: conditionsOf(runs[runs.length - 1].result),
    runs: runs.map(({ dir, result }) => ({
      dir: toRepoRelative(path.resolve(dir), root),
      runId: result.runId,
      subject: result.subject,
      testType: result.testType,
      status: result.status,
    })),
    metrics,
  };
  writeGeneratedJson(file, BASELINE_COMMENT, baseline);
  return { baseline, file, warnings };
}

/**
 * Loads a baseline by name ("$comment" dropped by the JSON loader).
 * @param {string} name
 * @param {{baselinesDir?: string}} [options]
 * @returns {object}
 */
export function loadBaseline(name, { baselinesDir = DEFAULT_BASELINES_DIR } = {}) {
  validateBaselineName(name);
  const file = path.join(baselinesDir, `${name}.json`);
  if (!fs.existsSync(file)) {
    const known = listBaselines({ baselinesDir }).map((b) => b.name);
    throw new RefusedError(`No baseline ${name} (${file}). Known: ${known.join(', ') || 'none'}`);
  }
  const baseline = readJson(file);
  if (baseline.kind !== BASELINE_KIND)
    throw new RefusedError(`${file} is not a baseline (kind ${baseline.kind})`);
  return baseline;
}

/**
 * Lists saved baselines with a few facts each.
 * Why: `baseline list` shows what can be compared against.
 * @param {{baselinesDir?: string}} [options]
 * @returns {Array<{name, savedAt, provisional, environment, planDefinitionSet, runs, note}>}
 */
export function listBaselines({ baselinesDir = DEFAULT_BASELINES_DIR } = {}) {
  if (!fs.existsSync(baselinesDir)) return [];
  return fs
    .readdirSync(baselinesDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const baseline = readJson(path.join(baselinesDir, file));
      if (baseline.kind !== BASELINE_KIND) return null;
      return {
        name: baseline.name,
        savedAt: baseline.savedAt,
        provisional: Boolean(baseline.provisional),
        environment: baseline.conditions?.environment ?? null,
        planDefinitionSet: baseline.conditions?.planDefinitionSet?.name ?? null,
        runs: baseline.runs?.length ?? 0,
        note: baseline.note ?? '',
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}
