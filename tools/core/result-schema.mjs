/**
 * result-schema.mjs — hand-written validators for result.json, preflight.json and cleanup JSON.
 *
 * What:    Reports, baselines and the series summary trust the shape of result.json (plan §5.2); the
 *          preflight (§5.5) and cleanup (§5.6) files are saved next to it. These validators check the
 *          required fields, their types and allowed values, and return a list of problems in plain words
 *          (no JSON Schema library: one less dependency, clearer messages). The JSON Schema files in
 *          tools/results/ document the same shapes for people and editors.
 * How:     import { validateResult } from './result-schema.mjs';
 *          const problems = validateResult(result); if (problems.length) …
 * Needs:   Nothing.
 * Outputs: string[] — empty when valid.
 */

/** Allowed values (plan §5.2, §5.5, §5.6). */
export const RESULT_STATUSES = ['passed', 'failed', 'aborted', 'error'];
export const TIMING_SOURCES = ['k6-setup', 'k6-rest-api', 'seed', 'estimated'];
export const WHAT_BROKE_SOURCES = ['k6', 'watcher', 'data-check', 'service-metrics'];
export const DATA_CHECK_COMPARISONS = ['equals', 'at-least', 'at-most', 'between'];
export const PREFLIGHT_STATUSES = ['passed', 'passed-with-warnings', 'failed'];
export const CHECK_STATUSES = ['pass', 'fail', 'warn', 'skip'];
export const CLEANUP_STATUSES = ['verified', 'incomplete', 'refused', 'dry-run', 'error'];
export const CLEANUP_MODES = ['dry-run', 'delete', 'print-sql'];

/**
 * A tiny checker bound to one problems list.
 * Why: keeps each validator a readable list of "this field must be …" lines.
 */
function checker(problems) {
  const typeOf = (value) =>
    value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const get = (object, path) =>
    path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), object);
  return {
    /** Field must exist (null allowed) — "never omitted" rule of §5.2. */
    present(object, path) {
      if (get(object, path) === undefined)
        problems.push(`${path} is missing (use null when it does not apply)`);
    },
    /** Field must have one of the given types ('null' allowed when listed). */
    type(object, path, ...types) {
      const value = get(object, path);
      if (value === undefined) problems.push(`${path} is missing`);
      else if (!types.includes(typeOf(value)))
        problems.push(`${path} must be ${types.join(' or ')}, got ${typeOf(value)}`);
    },
    /** Field must be one of the allowed values. */
    oneOf(object, path, allowed) {
      const value = get(object, path);
      if (!allowed.includes(value))
        problems.push(`${path} must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`);
    },
    /** Field must be an ISO-8601 time with an offset (or null when allowed). */
    time(object, path, { nullable = true } = {}) {
      const value = get(object, path);
      if (value === undefined) return problems.push(`${path} is missing`);
      if (value === null)
        return nullable ? undefined : problems.push(`${path} must be a time, got null`);
      if (
        typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)
      ) {
        problems.push(`${path} must be an ISO-8601 time with offset, got ${JSON.stringify(value)}`);
      }
      return undefined;
    },
  };
}

/**
 * Validates a result.json object (plan §5.2).
 * Why: `report` refuses to render (and unit tests fail) on a malformed result instead of printing nonsense.
 * @param {any} result
 * @returns {string[]}
 */
export function validateResult(result) {
  const problems = [];
  if (!result || typeof result !== 'object') return ['result must be a JSON object'];
  const c = checker(problems);
  c.oneOf(result, 'schemaVersion', ['1.0.0']);
  c.oneOf(result, 'kind', ['cce-performance-result']);
  for (const field of ['runId', 'service', 'subject', 'testType', 'statusReason'])
    c.type(result, field, 'string');
  c.oneOf(result, 'status', RESULT_STATUSES);
  c.time(result, 'startedAt', { nullable: false });
  c.time(result, 'endedAt');
  c.type(result, 'durationSeconds', 'number', 'null');

  c.type(result, 'timing', 'object');
  if (result.timing) {
    c.oneOf(result, 'timing.source', TIMING_SOURCES);
    c.time(result, 'timing.k6StartedAt');
    c.time(result, 'timing.measureStart');
    c.time(result, 'timing.sendEnd');
    c.type(result, 'timing.sendEndedEarly', 'boolean');
  }
  c.type(result, 'phases', 'array');
  (result.phases ?? []).forEach((phase, i) => {
    c.type(result, `phases.${i}.name`, 'string');
    c.time(result, `phases.${i}.startedAt`);
    c.time(result, `phases.${i}.endedAt`);
  });

  c.type(result, 'expectation', 'object');
  if (result.expectation) {
    c.type(result, 'expectation.summary', 'string', 'null');
    c.type(result, 'expectation.targetRate', 'number', 'null');
    c.type(result, 'expectation.toBeConfirmed', 'boolean');
  }

  c.type(result, 'load', 'object');
  if (result.load) {
    c.oneOf(result, 'load.unit', ['events', 'alarms']);
    for (const field of [
      'plannedEvents',
      'eventsSent',
      'eventsAccepted',
      'eventsFailed',
      'eventsDropped',
      'droppedRate',
      'droppedAllowed',
      'eventsProcessed',
      'measuredSeconds',
      'averageRate',
      'targetRate',
    ]) {
      c.type(result, `load.${field}`, 'number', 'null');
    }
    // "Went through" fields (events-through.mjs): written by every new result; optional so that
    // result.json files written before them still validate (reports then derive them).
    for (const field of ['eventsThrough', 'throughSeconds']) {
      if (result.load[field] !== undefined) c.type(result, `load.${field}`, 'number', 'null');
    }
    if (result.load.throughBasis !== undefined && result.load.throughBasis !== null)
      c.oneOf(result, 'load.throughBasis', ['accepted', 'processed', 'handled', 'sent']);
  }
  c.type(result, 'latency', 'object', 'null');

  c.type(result, 'thresholds', 'array');
  (result.thresholds ?? []).forEach((t, i) => {
    c.type(result, `thresholds.${i}.id`, 'string');
    c.type(result, `thresholds.${i}.passed`, 'boolean');
    c.type(result, `thresholds.${i}.description`, 'string');
    c.type(result, `thresholds.${i}.toBeConfirmed`, 'boolean');
    c.present(result, `thresholds.${i}.limit`);
    c.present(result, `thresholds.${i}.actual`);
  });
  const ids = (result.thresholds ?? []).map((t) => t.id);
  if (new Set(ids).size !== ids.length) problems.push('thresholds ids must be unique');

  c.type(result, 'breaking', 'object');
  if (result.breaking) {
    c.type(result, 'breaking.broke', 'boolean');
    c.time(result, 'breaking.startedBreakingAt');
    for (const field of [
      'secondsIntoMeasure',
      'rateAtBreak',
      'heldUpTo',
      'brokeAtRate',
      'catchUpSeconds',
      'remainingBacklog',
      'gaveUpAfterSeconds',
      'drainRate',
    ]) {
      c.type(result, `breaking.${field}`, 'number', 'null');
    }
    c.type(result, 'breaking.k6Limited', 'boolean');
    c.type(result, 'breaking.caughtUp', 'boolean', 'null');
    c.type(result, 'breaking.whatBroke', 'array');
    (result.breaking.whatBroke ?? []).forEach((w, i) => {
      c.type(result, `breaking.whatBroke.${i}.description`, 'string');
      c.oneOf(result, `breaking.whatBroke.${i}.source`, WHAT_BROKE_SOURCES);
    });
    // Never a numeric catch-up time when it did not catch up (fixes the v1 give-up bug, D19).
    if (result.breaking.caughtUp === false && result.breaking.catchUpSeconds !== null) {
      problems.push('breaking.catchUpSeconds must be null when caughtUp is false');
    }
  }
  c.type(result, 'levels', 'array', 'null');
  c.type(result, 'timeSeries', 'object');
  if (result.timeSeries) c.type(result, 'timeSeries.points', 'array');
  c.type(result, 'serviceMetrics', 'object', 'null');

  c.type(result, 'dataChecks', 'array');
  (result.dataChecks ?? []).forEach((check, i) => {
    c.type(result, `dataChecks.${i}.id`, 'string');
    c.type(result, `dataChecks.${i}.passed`, 'boolean');
    c.oneOf(result, `dataChecks.${i}.comparison`, DATA_CHECK_COMPARISONS);
    c.oneOf(result, `dataChecks.${i}.severity`, ['required', 'info']);
  });

  c.type(result, 'conditions', 'object');
  if (result.conditions) {
    c.type(result, 'conditions.settings', 'object');
    c.present(result, 'conditions.planDefinitionSet');
  }
  c.present(result, 'baselineComparison');
  c.type(result, 'artifacts', 'object');
  if (result.artifacts) c.present(result, 'artifacts.k6ExitCode');
  c.type(result, 'warnings', 'array');
  c.type(result, 'notes', 'array');
  return problems;
}

/**
 * Validates preflight.json (plan §5.5).
 * Why: run copies preflight warnings into the result and refuses on a failed preflight.
 * @param {any} preflight
 * @returns {string[]}
 */
export function validatePreflight(preflight) {
  const problems = [];
  if (!preflight || typeof preflight !== 'object') return ['preflight must be a JSON object'];
  const c = checker(problems);
  c.oneOf(preflight, 'schemaVersion', ['1.0.0']);
  c.oneOf(preflight, 'kind', ['cce-preflight']);
  c.type(preflight, 'environment', 'string');
  c.time(preflight, 'startedAt', { nullable: false });
  c.oneOf(preflight, 'status', PREFLIGHT_STATUSES);
  c.type(preflight, 'checks', 'array');
  (preflight.checks ?? []).forEach((check, i) => {
    c.type(preflight, `checks.${i}.id`, 'string');
    c.type(preflight, `checks.${i}.title`, 'string');
    c.oneOf(preflight, `checks.${i}.severity`, ['required', 'warning']);
    c.oneOf(preflight, `checks.${i}.status`, CHECK_STATUSES);
  });
  // The overall status must agree with the checks.
  const checks = preflight.checks ?? [];
  const requiredFailed = checks.some(
    (check) => check.severity === 'required' && check.status === 'fail',
  );
  if (requiredFailed && preflight.status !== 'failed')
    problems.push('status must be failed when a required check failed');
  return problems;
}

/**
 * Validates a cleanup JSON (plan §5.6).
 * Why: "verified" must really mean every table's after-count is 0 (R14).
 * @param {any} cleanup
 * @returns {string[]}
 */
export function validateCleanup(cleanup) {
  const problems = [];
  if (!cleanup || typeof cleanup !== 'object') return ['cleanup must be a JSON object'];
  const c = checker(problems);
  c.oneOf(cleanup, 'schemaVersion', ['1.0.0']);
  c.oneOf(cleanup, 'kind', ['cce-cleanup']);
  c.type(cleanup, 'environment', 'string');
  c.oneOf(cleanup, 'mode', CLEANUP_MODES);
  c.type(cleanup, 'scope', 'object');
  if (cleanup.scope) {
    c.present(cleanup, 'scope.runId');
    c.type(cleanup, 'scope.all', 'boolean');
    c.type(cleanup, 'scope.selectors', 'array');
  }
  c.time(cleanup, 'startedAt', { nullable: false });
  c.oneOf(cleanup, 'status', CLEANUP_STATUSES);
  c.type(cleanup, 'guards', 'array');
  c.type(cleanup, 'tables', 'array');
  (cleanup.tables ?? []).forEach((table, i) => {
    c.type(cleanup, `tables.${i}.table`, 'string');
    c.type(cleanup, `tables.${i}.order`, 'number');
    c.present(cleanup, `tables.${i}.before`);
    c.present(cleanup, `tables.${i}.after`);
  });
  if (
    cleanup.status === 'verified' &&
    (cleanup.tables ?? []).some((t) => t.exists !== false && t.after !== 0)
  ) {
    problems.push('status verified needs every table after = 0');
  }
  c.type(cleanup, 'totals', 'object');
  return problems;
}
