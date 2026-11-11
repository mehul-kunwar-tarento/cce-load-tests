/**
 * settings.mjs — resolves every test setting for one run: the single source of truth (plan §3.3, D17).
 *
 * What:    Testers change rates, durations, totals and limits without editing code. Each setting is
 *          defined once in config/settings/defaults.json (default, type, unit, description, "to be
 *          confirmed" flag). For a run, the value comes from (low → high precedence):
 *            defaults.json → environment "settings" → environment variable of the same name → --set
 *          (values from `run --refine-from` sit between the environment variable and --set, but never
 *          replace an environment variable; their source is "refine-from").
 *          Values get pinned types (durations in SECONDS, LEVELS as a number array, unset = null), and
 *          the derived values are computed here and only here: <TYPE>_EVENTS → <TYPE>_DURATION
 *          (= events / rate to the microsecond, so the measured phase plans exactly that many events),
 *          STEP_SLA_MAX_WAIT=auto, STEP_SLA_PEAK_ALARM_RATE=auto, the phase plan, the run id.
 * How:     import { resolveSettings, printSettings, settingsForResult } from './settings.mjs';
 *          const resolved = resolveSettings({ environment, subject: 'collector', testType: 'load',
 *                                             breakpointKind: 'staircase', overrides: { LOAD_EVENTS: '1000' } });
 * Needs:   config/settings/defaults.json; lib/duration.js and lib/phase-plan.js (through lib-bridge.mjs).
 * Outputs: ResolvedSettings = { values, sources, derived: { phasePlan, … }, warnings, context }.
 *          Throws RefusedError (exit 2) for a bad value (including a ratio outside 0 … 1), an unknown --set
 *          name or a forbidden setting.
 */
import { RefusedError, UsageError } from './errors.mjs';
import { formatNumber, markdownTable } from './format.mjs';
import { readConfigJson } from './json-file.mjs';
import { buildPhasePlan, formatDuration, parseDuration } from './lib-bridge.mjs';
import { FOLDERS, repoPath } from './paths.mjs';
import { createRunId, testDataPrefix, validateRunId } from './run-id.mjs';

/** Where the definitions live (plan §3.2). */
export const DEFAULTS_FILE = repoPath(FOLDERS.settings, 'defaults.json');

/** CloudEvent ids longer than this are rejected by the collector (plan §2.3). */
export const MAX_CLOUD_EVENT_ID_LENGTH = 50;

/** Settings whose <PREFIX>_EVENTS total turns into <PREFIX>_DURATION (plan §3.3). */
const EVENT_TOTALS = ['SMOKE', 'LOAD', 'STRESS', 'MATCHER_FLOOD'];

/** appliesTo tokens that name a subject or a test type (relevance filter of printSettings). */
const SUBJECT_TOKENS = ['collector', 'matcher', 'step-sla'];
const TEST_TYPE_TOKENS = ['smoke', 'load', 'stress', 'breakpoint'];
/** Tokens of settings that only tools other than `run` use (cleanup, plan-definitions, baseline). */
const TOOL_ONLY_TOKENS = ['cleanup', 'plan-definitions', 'baseline'];

/** Id code per known subject, used to check the longest event id (plan §2.1). */
const ID_CODE_BY_SUBJECT = { collector: 'col', matcher: 'mat', 'step-sla': 'sla' };

const definitionCache = new Map();

/**
 * Loads the setting definitions (cached per file).
 * Why: read once per process; "$comment" is dropped by readConfigJson so it is never a setting.
 * @param {{file?: string}} [options]
 * @returns {Record<string, {default:any, type:string, unit:string, appliesTo:string[], description:string,
 *           toBeConfirmed:boolean, enum?:string[], allowAuto?:boolean}>}
 */
export function loadSettingDefinitions({ file = DEFAULTS_FILE } = {}) {
  if (!definitionCache.has(file)) definitionCache.set(file, readConfigJson(file));
  return definitionCache.get(file);
}

/**
 * Turns one raw value (from JSON, an env var or --set) into its pinned type (plan §3.3 table).
 * Why: k6 and every Node module receive the same, already-checked types; a typo fails here, loudly.
 * @param {string} name setting name (for messages)
 * @param {object} definition its defaults.json entry
 * @param {unknown} raw
 * @returns {unknown} typed value, null for unset, or the string 'auto' for allowAuto settings
 */
export function parseSettingValue(name, definition, raw) {
  // "" (or nothing) means unset, for every type.
  if (raw === undefined || raw === null || raw === '') return null;
  const text = typeof raw === 'string' ? raw.trim() : raw;
  if (definition.allowAuto && text === 'auto') return 'auto';
  const fail = (hint) => {
    throw new RefusedError(`Setting ${name}=${JSON.stringify(raw)} is invalid: ${hint}`);
  };
  switch (definition.type) {
    case 'rate': {
      const value = Number(text);
      if (!Number.isInteger(value) || value < 1)
        fail('a rate is a whole number of events per second ≥ 1');
      return value;
    }
    case 'duration':
      try {
        return parseDuration(text);
      } catch (error) {
        return fail(error.message);
      }
    case 'integer': {
      const value = Number(text);
      if (!Number.isInteger(value) || value < 0) fail('expected a whole number ≥ 0');
      return value;
    }
    case 'number': {
      const value = Number(text);
      if (typeof text === 'boolean' || !Number.isFinite(value)) fail('expected a number');
      return value;
    }
    case 'boolean': {
      if (text === true || text === 'true' || text === '1' || text === 1) return true;
      if (text === false || text === 'false' || text === '0' || text === 0) return false;
      return fail('expected true or false');
    }
    case 'list': {
      // Lists are rates (LEVELS): "200,400,800" → [200, 400, 800], strictly ascending.
      const parts = Array.isArray(text) ? text : String(text).split(',');
      const values = parts.map((part) => Number(String(part).trim()));
      values.forEach((value, i) => {
        if (!Number.isInteger(value) || value < 1) fail('expected comma-separated whole rates ≥ 1');
        if (i > 0 && value <= values[i - 1]) fail('the list must be strictly ascending');
      });
      return values;
    }
    case 'enum': {
      const value = String(text);
      if (!definition.enum?.includes(value)) fail(`expected one of ${definition.enum?.join(', ')}`);
      return value;
    }
    case 'string':
      return String(text);
    default:
      throw new Error(`defaults.json: setting ${name} has unknown type "${definition.type}"`);
  }
}

/**
 * Parses repeated `--set NAME=value` arguments into an overrides object.
 * Why: every command accepts --set the same way.
 * @param {string[]} [pairs]
 * @returns {Record<string, string>}
 */
export function parseSetArgs(pairs = []) {
  const overrides = {};
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    if (index < 1) throw new UsageError(`--set needs NAME=value, got "${pair}"`);
    overrides[pair.slice(0, index).trim()] = pair.slice(index + 1);
  }
  return overrides;
}

/**
 * Resolves every setting for one run (plan §3.3).
 * Why: the ONE place where precedence, types and derivations are decided, so the printout, k6,
 * the watchers and the saved result can never disagree.
 * @param {object} input
 * @param {object} [input.environment] loaded environment (settings, safety, services)
 * @param {string|null} [input.subject] e.g. 'collector' (optional: cleanup/preflight resolve without)
 * @param {string|null} [input.testType] smoke | load | stress | breakpoint
 * @param {string|null} [input.breakpointKind] staircase | flood | none (from the service module)
 * @param {{expectedRows?: {dueAlarms?: number}}|null} [input.setContext] for STEP_SLA_PEAK_ALARM_RATE=auto
 * @param {Record<string, unknown>} [input.overrides] --set values (unknown names are an error)
 * @param {Record<string, unknown>} [input.refinements] values from `run --refine-from` (LEVELS, WARM_UP_RATE):
 *        above the environment, below the tester's own env var or --set; source "refine-from"
 * @param {Record<string, string|undefined>} [input.env] environment variables (unknown names ignored)
 * @param {Date} [input.now] run start (for the automatic RUN_ID)
 * @param {string|null} [input.idCode] id code of the subject (for the 50-character event-id check)
 * @param {object} [input.definitions] defaults.json content (tests pass their own)
 * @returns {{values:Record<string, any>, sources:Record<string, string>, derived:object, warnings:string[],
 *            context:{subject:string|null, testType:string|null, breakpointKind:string|null}}}
 */
export function resolveSettings({
  environment = null,
  subject = null,
  testType = null,
  breakpointKind = null,
  setContext = null,
  overrides = {},
  refinements = {},
  env = process.env,
  now = new Date(),
  idCode = null,
  definitions = loadSettingDefinitions(),
} = {}) {
  const warnings = [];
  const raw = {};
  const sources = {};

  // 1. defaults.json
  for (const [name, definition] of Object.entries(definitions)) {
    raw[name] = definition.default;
    sources[name] = 'default';
  }
  // 2. environment: settings block, plus safety.minFreeDiskGb for MIN_FREE_DISK_GB (plan §3.2).
  if (environment?.safety?.minFreeDiskGb !== undefined && 'MIN_FREE_DISK_GB' in definitions) {
    raw.MIN_FREE_DISK_GB = environment.safety.minFreeDiskGb;
    sources.MIN_FREE_DISK_GB = 'environment';
  }
  for (const [name, value] of Object.entries(environment?.settings ?? {})) {
    if (!(name in definitions)) {
      warnings.push(`Environment ${environment.name} sets unknown setting ${name}: ignored`);
      continue;
    }
    raw[name] = value;
    sources[name] = 'environment';
  }
  // 3. environment variables: only names defined in defaults.json; empty values count as "not given".
  for (const name of Object.keys(definitions)) {
    if (env[name] !== undefined && env[name] !== '') {
      raw[name] = env[name];
      sources[name] = 'env-var';
    }
  }
  // 3b. --refine-from (a previous breakpoint result): its own source, so the printout and the saved
  //     settings show where LEVELS and WARM_UP_RATE came from; the tester's env var still wins.
  for (const [name, value] of Object.entries(refinements ?? {})) {
    if (!(name in definitions)) throw new Error(`--refine-from produced unknown setting ${name}`);
    if (sources[name] === 'env-var') continue;
    raw[name] = value;
    sources[name] = 'refine-from';
  }
  // 4. --set: an unknown name is a typo, so it is an error (plan §3.3).
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (!(name in definitions)) {
      throw new RefusedError(
        `Unknown setting ${name} in --set (see config/settings/defaults.json)`,
      );
    }
    raw[name] = value;
    sources[name] = 'cli';
  }

  // Types (plan §3.3 table).
  const values = {};
  for (const [name, definition] of Object.entries(definitions)) {
    values[name] = parseSettingValue(name, definition, raw[name]);
  }

  // Reserved settings: later work, refused now with a clear message (plan §3.2).
  if (
    values.EVENT_MODE !== null &&
    values.EVENT_MODE !== undefined &&
    values.EVENT_MODE !== 'single'
  ) {
    throw new RefusedError(
      `EVENT_MODE=${values.EVENT_MODE} is not implemented yet: only 'single' is supported`,
    );
  }
  if (values.WORKLOAD_PROFILE) {
    throw new RefusedError(
      'WORKLOAD_PROFILE is not implemented yet (spec 007 defines the profile format): leave it empty',
    );
  }

  // Ratios (unit "ratio" in defaults.json): 0 … 1, and never a value that makes its k6 rule meaningless.
  checkRatios(values, definitions, warnings);

  // <TYPE>_EVENTS → <TYPE>_DURATION = events / rate, to the microsecond: derived here and only here
  // (plan §3.3). Not rounded up to whole seconds: 1,000 events at 80/s is 12.5 s, so the measured
  // phase plans exactly 1,000 events (lib/phase-plan.js and lib/scenarios.js handle fractional phases).
  for (const prefix of EVENT_TOTALS) {
    const events = values[`${prefix}_EVENTS`];
    if (events === null || events === undefined) continue;
    if (events < 1) throw new RefusedError(`Setting ${prefix}_EVENTS must be at least 1`);
    const rate = values[`${prefix}_RATE`];
    if (sources[`${prefix}_DURATION`] !== 'default') {
      warnings.push(
        `${prefix}_EVENTS and ${prefix}_DURATION are both set: ${prefix}_EVENTS wins ` +
          `(duration = ${events} / ${rate}/s)`,
      );
    }
    values[`${prefix}_DURATION`] = Math.round((events / rate) * 1e6) / 1e6;
    sources[`${prefix}_DURATION`] = 'derived';
  }

  // STEP_SLA_MAX_WAIT=auto → 2 × the Step SLA poll interval of this environment.
  if (values.STEP_SLA_MAX_WAIT === 'auto') {
    const poll = environment?.services?.stepSla?.pollIntervalSeconds;
    values.STEP_SLA_MAX_WAIT = typeof poll === 'number' ? 2 * poll : null;
    sources.STEP_SLA_MAX_WAIT = 'derived';
  }
  // STEP_SLA_PEAK_ALARM_RATE=auto → ceil(PEAK_RATE × due alarms per event of the set) (plan §3.2).
  if (values.STEP_SLA_PEAK_ALARM_RATE === 'auto') {
    const dueAlarms = setContext?.expectedRows?.dueAlarms;
    values.STEP_SLA_PEAK_ALARM_RATE =
      typeof dueAlarms === 'number' ? Math.max(1, Math.ceil(values.PEAK_RATE * dueAlarms)) : null;
    sources.STEP_SLA_PEAK_ALARM_RATE = 'derived';
  }

  // RUN_ID: automatic yyyymmdd-hhmmss unless given; always validated (plan §2.3).
  if (values.RUN_ID === null) {
    values.RUN_ID = createRunId(now);
    sources.RUN_ID = 'derived';
  }
  validateRunId(values.RUN_ID);

  // Phase plan: the same code k6 runs (lib/phase-plan.js); only with subject + test type + kind.
  let phasePlan = null;
  if (subject && testType && breakpointKind) {
    try {
      phasePlan = buildPhasePlan({ testType, settings: values, breakpointKind });
    } catch (error) {
      throw new RefusedError(`Settings do not make a valid ${testType} test: ${error.message}`);
    }
  }

  // An event total is a promise to the tester: say so when the plan does not send exactly that many.
  const totalPrefix = eventTotalPrefix(testType, breakpointKind);
  const requested = totalPrefix ? values[`${totalPrefix}_EVENTS`] : null;
  if (phasePlan && typeof requested === 'number' && phasePlan.plannedMeasuredEvents !== requested) {
    warnings.push(
      `${totalPrefix}_EVENTS: requested ${formatNumber(requested)}, planned ` +
        `${formatNumber(phasePlan.plannedMeasuredEvents)} in the measured phase`,
    );
  }

  // The longest CloudEvent id this run can produce must fit the collector's 50 characters.
  const longestEventIdLength = longestEventId({
    runId: values.RUN_ID,
    idCode: idCode ?? ID_CODE_BY_SUBJECT[subject] ?? 'xxx',
    phasePlan,
  }).length;
  if (longestEventIdLength > MAX_CLOUD_EVENT_ID_LENGTH) {
    throw new RefusedError(
      `RUN_ID "${values.RUN_ID}" makes event ids ${longestEventIdLength} characters long ` +
        `(collector limit ${MAX_CLOUD_EVENT_ID_LENGTH}): use a shorter RUN_ID`,
    );
  }

  return {
    values,
    sources,
    derived: {
      phasePlan,
      stepSlaMaxWaitSeconds: values.STEP_SLA_MAX_WAIT ?? null,
      stepSlaPeakAlarmRate: values.STEP_SLA_PEAK_ALARM_RATE ?? null,
      longestEventIdLength,
    },
    warnings,
    context: { subject, testType, breakpointKind },
    definitions,
  };
}

/**
 * The <PREFIX> of the <PREFIX>_EVENTS total that sizes this test's measured phase, or null.
 * Why: the "requested vs planned" check compares the right total (STRESS_EVENTS for a stress run, …).
 * @param {string|null} testType
 * @param {string|null} breakpointKind
 * @returns {string|null}
 */
function eventTotalPrefix(testType, breakpointKind) {
  if (testType === 'smoke') return 'SMOKE';
  if (testType === 'load') return 'LOAD';
  if (testType === 'stress') return 'STRESS';
  if (testType === 'breakpoint' && breakpointKind === 'flood') return 'MATCHER_FLOOD';
  return null;
}

/**
 * Range-checks every setting whose defaults.json unit is "ratio" (a share between 0 and 1).
 * Why: HTTP_MAX_FAILED_RATE=1 typed as "1 %" gives the k6 rule `rate<1`, which can never fail; a value
 *      outside 0 … 1 gives a rule that always passes or always fails. Refused (exit 2), never silent.
 *      Two edge values are refused too, because their k6 rule can never pass:
 *      MIN_CHECKS_RATE=1 (`rate>1`) and HTTP_MAX_FAILED_RATE=0 (`rate<0`).
 * @param {Record<string, any>} values typed values
 * @param {object} definitions defaults.json content
 * @param {string[]} warnings collects "this rule can never fail" warnings
 */
export function checkRatios(values, definitions, warnings = []) {
  for (const [name, definition] of Object.entries(definitions)) {
    const value = values[name];
    if (definition.unit !== 'ratio' || typeof value !== 'number') continue;
    if (value < 0 || value > 1) {
      throw new RefusedError(
        `Setting ${name}=${value} is invalid: a ratio is between 0 and 1 (e.g. 0.01 = 1 %)`,
      );
    }
  }
  if (values.MIN_CHECKS_RATE === 1) {
    throw new RefusedError(
      'Setting MIN_CHECKS_RATE=1 is invalid: the rule "more than 100 % of checks passed" can never ' +
        'pass; use e.g. 0.999',
    );
  }
  if (values.HTTP_MAX_FAILED_RATE === 0) {
    throw new RefusedError(
      'Setting HTTP_MAX_FAILED_RATE=0 is invalid: the rule "less than 0 % of requests failed" can never ' +
        'pass; use e.g. 0.0001',
    );
  }
  if (values.HTTP_MAX_FAILED_RATE === 1) {
    warnings.push(
      'HTTP_MAX_FAILED_RATE=1 allows 100 % failed requests (the rule can never fail); 1 % is 0.01',
    );
  }
  return warnings;
}

/**
 * The longest CloudEvent id a run can produce: LOADTEST-<runId>-<idCode>-<phaseIndex>-<n>-<step>.
 * Why: plan §2.3 — checking it up front avoids 400 responses ten minutes into a run. Without a phase
 * plan, a conservative 9-digit iteration number is assumed.
 * @param {{runId:string, idCode:string, phasePlan:object|null}} input
 * @returns {string}
 */
export function longestEventId({ runId, idCode, phasePlan }) {
  const phaseCount = phasePlan?.phases?.length ?? 1;
  const largestPhase = phasePlan
    ? Math.max(1, ...phasePlan.phases.map((phase) => phase.plannedEvents ?? 1))
    : 1e9;
  // Single-event mode: step number is always 1 (EVENT_MODE=journey is later work).
  return `${testDataPrefix(runId)}${idCode}-${phaseCount - 1}-${largestPhase - 1}-1`;
}

/**
 * Fills DATASET, EVENT_ACTION_ID, EVENT_SOURCE and FACILITY_ID from the dataset when the tester left them empty.
 * Why: their defaults live in the dataset (plan §3.2); DATASET itself may come from the plan-definition set.
 * @param {ReturnType<typeof resolveSettings>} resolved
 * @param {{name?:string, defaultActionId?:string, source?:string, facilityId?:string}|null} dataset
 * @returns {ReturnType<typeof resolveSettings>} a copy
 */
export function applyDatasetDefaults(resolved, dataset) {
  if (!dataset) return resolved;
  const values = { ...resolved.values };
  const sources = { ...resolved.sources };
  const fill = (name, value) => {
    if (name in values && values[name] === null && value) {
      values[name] = value;
      sources[name] = 'derived';
    }
  };
  fill('DATASET', dataset.name);
  fill('EVENT_ACTION_ID', dataset.defaultActionId);
  fill('EVENT_SOURCE', dataset.source);
  fill('FACILITY_ID', dataset.facilityId);
  return { ...resolved, values, sources };
}

/**
 * True when a setting matters for a run of this subject and test type.
 * Why: the printout shows the ~20 settings that matter, not all ~75 (plan §3.4).
 * @param {{appliesTo:string[]}} definition
 * @param {{subject?:string|null, testType?:string|null}} context
 * @returns {boolean}
 */
export function isRelevant(definition, { subject = null, testType = null } = {}) {
  const tokens = definition.appliesTo ?? ['all'];
  if (tokens.includes('all')) return true;
  const subjects = tokens.filter((token) => SUBJECT_TOKENS.includes(token));
  const types = tokens.filter((token) => TEST_TYPE_TOKENS.includes(token));
  // Settings only cleanup/plan-definitions/baseline use are not part of a run printout.
  if (!subjects.length && !types.length) {
    return !tokens.every((token) => TOOL_ONLY_TOKENS.includes(token));
  }
  // An unknown subject (e.g. the stub, a later adaptor) is not filtered by subject tokens.
  const subjectOk =
    !subject || !subjects.length || subjects.includes(subject) || !SUBJECT_TOKENS.includes(subject);
  const typeOk = !testType || !types.length || types.includes(testType);
  return subjectOk && typeOk;
}

/**
 * Formats one typed value for people.
 * Why: durations print as "10m 0s (600 s)", lists as "200,400", unset as "(unset)".
 * @param {object} definition
 * @param {unknown} value
 * @returns {string}
 */
export function formatSettingValue(definition, value) {
  if (value === null || value === undefined) return '(unset)';
  if (definition?.type === 'duration' && typeof value === 'number') {
    return `${formatDuration(value)}`;
  }
  if (Array.isArray(value)) return value.join(',');
  if (typeof value === 'number')
    return `${formatNumber(value, 6)}${definition?.unit === '%' ? '%' : ''}`;
  return String(value);
}

/**
 * The phase plan as a Markdown table (phase, kind, rate, start, duration, planned events).
 * Why: printed before every run and by `settings`, so the tester sees exactly what k6 will do.
 * @param {object|null} phasePlan
 * @returns {string}
 */
export function formatPhasePlan(phasePlan) {
  if (!phasePlan) return '';
  const rows = [];
  for (const phase of phasePlan.phases) {
    rows.push([
      phase.name,
      phase.kind,
      phase.rate === 0 ? 'all at once' : `${formatNumber(phase.rate)}/s`,
      formatDuration(phase.startSeconds),
      formatDuration(phase.durationSeconds),
      formatNumber(phase.plannedEvents),
    ]);
    for (const level of phase.levels ?? []) {
      rows.push([
        `  level ${formatNumber(level.rate)}/s`,
        'level',
        `${formatNumber(level.rate)}/s`,
        formatDuration(level.startSeconds),
        formatDuration(level.durationSeconds),
        formatNumber(level.plannedEvents),
      ]);
    }
  }
  const footer =
    `Planned: ${formatNumber(phasePlan.plannedEvents)} events in total, ` +
    `${formatNumber(phasePlan.plannedMeasuredEvents)} in the measured phase "${phasePlan.measuredPhase}"; ` +
    `report windows of ${formatDuration(phasePlan.windowSeconds)} (${phasePlan.windowCount}).`;
  return `${markdownTable(['Phase', 'Kind', 'Rate', 'Starts at', 'Duration', 'Planned events'], rows)}\n${footer}`;
}

/**
 * The settings table printed at the start of every run and by `settings` (plan §3.4).
 * Why: the tester sees which values are in force and where each came from; "TBC" marks values still to
 * be confirmed from UAT/Dev data. Settings changed from their default are always shown.
 * @param {ReturnType<typeof resolveSettings>} resolved
 * @param {{onlyRelevant?: boolean, includePhasePlan?: boolean}} [options]
 * @returns {string}
 */
export function printSettings(resolved, { onlyRelevant = true, includePhasePlan = true } = {}) {
  const definitions = resolved.definitions ?? loadSettingDefinitions();
  const rows = [];
  for (const [name, definition] of Object.entries(definitions)) {
    // Values the tester (or the environment file) changed are always shown; derived ones only if relevant.
    const changed = ['environment', 'env-var', 'refine-from', 'cli'].includes(
      resolved.sources[name],
    );
    if (onlyRelevant && !changed && !isRelevant(definition, resolved.context)) continue;
    rows.push([
      name,
      formatSettingValue(definition, resolved.values[name]),
      resolved.sources[name],
      definition.toBeConfirmed ? 'TBC' : '',
    ]);
  }
  const parts = [markdownTable(['Setting', 'Value', 'Source', 'To be confirmed'], rows)];
  if (includePhasePlan && resolved.derived?.phasePlan)
    parts.push('', formatPhasePlan(resolved.derived.phasePlan));
  for (const warning of resolved.warnings ?? []) parts.push(`WARNING: ${warning}`);
  return parts.join('\n');
}

/**
 * What is saved in result.conditions.settings: { NAME: { value, source } } for every setting.
 * Why: a result must say under which settings it was measured (R1.5); secrets are never settings.
 * @param {ReturnType<typeof resolveSettings>} resolved
 * @returns {Record<string, {value:unknown, source:string}>}
 */
export function settingsForResult(resolved) {
  return Object.fromEntries(
    Object.keys(resolved.values).map((name) => [
      name,
      { value: resolved.values[name], source: resolved.sources[name] },
    ]),
  );
}
