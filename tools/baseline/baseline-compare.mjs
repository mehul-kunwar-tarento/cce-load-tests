/**
 * baseline-compare.mjs — compares runs with a saved baseline: better, worse or the same (plan §8.3).
 *
 * What:    For every metric the baseline holds, takes the mean of the given runs' values and compares it
 *          with the baseline mean. A change counts only past the tolerance (BASELINE_TOLERANCE, default
 *          20 %) AND past a floor per unit (5 ms, 2 s, 100 events, 5 events/s, 20 alarms/s), so laptop
 *          noise is not flagged. Direction comes from the metric ("lower is better" for p95, "higher" for
 *          rates). A catch-up that did not happen is "not caught up", never a number (D19). Conditions that
 *          differ (environment, machine, k6 image, plan-definition set, dataset, compared settings, data
 *          volume > 50 %, suite commit) are listed as warnings. A comparison is informational: it never
 *          changes a run's status.
 * How:     import { compareWithBaseline } from './baseline-compare.mjs';
 *          const comparison = compareWithBaseline({ baseline, results, metricsFor, tolerance: 20 });
 *          CLI: node tools/cli.mjs baseline compare <name> results/<dir>…   (or BASELINE=<name> on a run)
 * Needs:   A loaded baseline (baseline-store.mjs) and result.json objects.
 * Outputs: { baseline, provisional, tolerance, warnings, rows } — written as baseline-comparison.json.
 */
import { formatBytes, toIsoWithOffset } from '../core/format.mjs';
import { COMPARED_SETTINGS, collectMetrics, conditionsOf, statistics } from './baseline-store.mjs';

/** Smallest change that counts, per unit (plan §8.3); why: tiny absolute changes are noise. */
export const UNIT_FLOORS = { ms: 5, s: 2, events: 100, 'events/s': 5, 'alarms/s': 20 };

/** Header of baseline-comparison.json (plan §2.4). */
const COMPARISON_COMMENT =
  'What: comparison of one or more runs with a saved baseline (better / worse / same per metric) and the ' +
  'conditions that differ. How: written by `baseline compare` or by a run with BASELINE=<name>. Needs: ' +
  'nothing. Outputs: shown in report.md (informational, never changes the verdict).';

/**
 * Verdict of one metric.
 * Why: one rule for every metric: same within floor or tolerance, else better/worse by direction.
 * @param {{baseline:number, current:number, unit:string, better:'lower'|'higher', tolerance:number}} input
 * @returns {{delta:number, deltaPercent:number|null, verdict:'better'|'worse'|'same'}}
 */
export function judge({ baseline, current, unit, better, tolerance }) {
  const delta = current - baseline;
  const deltaPercent = baseline === 0 ? null : (delta / Math.abs(baseline)) * 100;
  const floor = UNIT_FLOORS[unit] ?? 0;
  const withinFloor = Math.abs(delta) < floor;
  const withinTolerance = deltaPercent === null ? delta === 0 : Math.abs(deltaPercent) <= tolerance;
  if (withinFloor || withinTolerance) return { delta, deltaPercent, verdict: 'same' };
  const improved = better === 'lower' ? delta < 0 : delta > 0;
  return { delta, deltaPercent, verdict: improved ? 'better' : 'worse' };
}

/** Relative difference of two numbers (0.5 = 50 %); why: data volume warnings use a 50 % rule. */
function relativeDifference(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return 0;
  const base = Math.max(Math.abs(a), Math.abs(b));
  return base === 0 ? 0 : Math.abs(a - b) / base;
}

/**
 * Conditions of the compared runs that differ from the baseline's (plan §8.3 "Condition warnings").
 * Why: a "worse" verdict on another machine or with 4× the data means something else.
 * @param {object} baselineConditions
 * @param {object} current conditionsOf(result) of a compared run
 * @returns {string[]}
 */
export function conditionWarnings(baselineConditions, current) {
  const warnings = [];
  const b = baselineConditions ?? {};
  const differs = (a, c) => JSON.stringify(a ?? null) !== JSON.stringify(c ?? null);
  if (differs(b.environment, current.environment))
    warnings.push(`environment ${current.environment} (baseline ${b.environment})`);
  if (
    differs(b.host?.hostname, current.host?.hostname) ||
    differs(b.host?.cpus, current.host?.cpus)
  ) {
    warnings.push(
      `host ${current.host?.hostname} ${current.host?.cpus} CPUs (baseline ${b.host?.hostname} ${b.host?.cpus} CPUs)`,
    );
  }
  if (differs(b.k6Image, current.k6Image))
    warnings.push(`k6 image ${current.k6Image} (baseline ${b.k6Image})`);
  const bs = b.planDefinitionSet ?? {};
  const cs = current.planDefinitionSet ?? {};
  if (
    differs(bs.name, cs.name) ||
    differs(bs.fanOut, cs.fanOut) ||
    differs(bs.canonicals, cs.canonicals)
  ) {
    warnings.push(
      `plan-definition set ${cs.name} fan-out ${cs.fanOut} (baseline ${bs.name} fan-out ${bs.fanOut})`,
    );
  }
  if (differs(b.dataset, current.dataset))
    warnings.push(`dataset ${current.dataset} (baseline ${b.dataset})`);
  for (const name of COMPARED_SETTINGS) {
    if (differs(b.settings?.[name], current.settings?.[name])) {
      warnings.push(
        `setting ${name}=${JSON.stringify(current.settings?.[name])} (baseline ${JSON.stringify(b.settings?.[name])})`,
      );
    }
  }
  const bv = b.dataVolume;
  const cv = current.dataVolume;
  if (bv && cv) {
    if (relativeDifference(bv.dbSizeBytes, cv.dbSizeBytes) > 0.5) {
      warnings.push(
        `database size ${formatBytes(cv.dbSizeBytes)} (baseline ${formatBytes(bv.dbSizeBytes)})`,
      );
    }
    for (const [table, rows] of Object.entries(bv.rows ?? {})) {
      if (relativeDifference(rows, cv.rows?.[table]) > 0.5) {
        warnings.push(`${table} rows ${cv.rows?.[table] ?? 'unknown'} (baseline ${rows})`);
      }
    }
  }
  if (b.suiteCommit && current.suiteCommit && b.suiteCommit !== current.suiteCommit) {
    warnings.push(`suite commit ${current.suiteCommit} (baseline ${b.suiteCommit})`);
  }
  return warnings;
}

/**
 * Compares runs with a baseline.
 * @param {object} input
 * @param {object} input.baseline loaded baseline
 * @param {object[]} input.results result.json objects of the runs to compare
 * @param {(result:object) => object[]} input.metricsFor baselineMetrics of each run's module
 * @param {number} [input.tolerance] BASELINE_TOLERANCE in percent
 * @param {Date} [input.now]
 * @returns {object} comparison (baseline-comparison.json body)
 */
export function compareWithBaseline({
  baseline,
  results,
  metricsFor,
  tolerance = 20,
  now = new Date(),
}) {
  const current = collectMetrics(results, metricsFor);
  const keys = [
    ...new Set([...Object.keys(baseline.metrics ?? {}), ...Object.keys(current)]),
  ].sort();
  const rows = keys.map((key) => {
    const base = baseline.metrics?.[key];
    const now_ = current[key];
    const label = base?.label ?? now_?.label ?? key;
    const unit = base?.unit ?? now_?.unit ?? '';
    const better = base?.better ?? now_?.better ?? 'lower';
    const row = {
      key,
      label,
      unit,
      better,
      baseline: base?.mean ?? null,
      baselineRuns: base?.runs ?? 0,
      current: null,
      currentRuns: 0,
      delta: null,
      deltaPercent: null,
      verdict: 'not-compared',
      note: null,
    };
    if (now_?.notCaughtUp) {
      // A catch-up that did not happen is never compared as a number.
      row.note = 'not caught up';
      return row;
    }
    if (!now_?.values.length || typeof row.baseline !== 'number') {
      row.note = !base ? 'not in the baseline' : 'not measured in these runs';
      if (now_?.values.length) row.current = statistics(now_.values).mean;
      return row;
    }
    row.current = statistics(now_.values).mean;
    row.currentRuns = now_.values.length;
    Object.assign(
      row,
      judge({ baseline: row.baseline, current: row.current, unit, better, tolerance }),
    );
    return row;
  });

  const warnings = [];
  for (const result of results) {
    for (const warning of conditionWarnings(baseline.conditions, conditionsOf(result))) {
      const text = `${result.subject} ${result.testType} ${result.runId}: ${warning}`;
      if (!warnings.includes(text)) warnings.push(text);
    }
  }
  if (baseline.provisional)
    warnings.unshift('the baseline is PROVISIONAL (saved with fewer runs than BASELINE_MIN_RUNS)');

  return {
    $comment: COMPARISON_COMMENT,
    schemaVersion: '1.0.0',
    kind: 'cce-baseline-comparison',
    comparedAt: toIsoWithOffset(now),
    baseline: baseline.name,
    provisional: Boolean(baseline.provisional),
    tolerance,
    runs: results.map((result) => ({
      runId: result.runId,
      subject: result.subject,
      testType: result.testType,
    })),
    warnings,
    rows,
  };
}
