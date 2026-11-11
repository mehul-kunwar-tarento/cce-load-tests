/**
 * lib-bridge.mjs — loads the PURE modules of the shared k6 library (lib/) into Node.
 *
 * What:    The phase plan, durations and threshold descriptions are computed by the SAME code in k6
 *          and in Node (plan §4: "pure" modules import nothing from k6). This bridge imports them once.
 *          The library is built by another work package (A1); if a module is missing, the bridge does
 *          not crash at import time: the first call that needs it throws a clear message instead.
 * How:     import { parseDuration, buildPhasePlan, isDummyRule } from './lib-bridge.mjs';
 * Needs:   lib/duration.js, lib/phase-plan.js, lib/thresholds.js, lib/windows.js (A1).
 * Outputs: Re-exported functions with the signatures of plan §4.1, §4.2, §4.4, §4.5.
 */

/** Library files this bridge loads, by short name. */
const FILES = {
  duration: 'duration.js',
  phasePlan: 'phase-plan.js',
  thresholds: 'thresholds.js',
  windows: 'windows.js',
};

/**
 * Imports one lib file, or returns null when the file does not exist (yet).
 * Why: a missing A1 module must not break commands that do not need it (e.g. `report`).
 * @param {string} file
 */
async function importLib(file) {
  try {
    return await import(new URL(`../../lib/${file}`, import.meta.url));
  } catch (error) {
    // Only "this very file is missing" is tolerated; a syntax error inside it must surface.
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes(file)) return null;
    throw error;
  }
}

// Top-level await: loaded once when this module is first imported.
const loaded = Object.fromEntries(
  await Promise.all(
    Object.entries(FILES).map(async ([name, file]) => [name, await importLib(file)]),
  ),
);

/**
 * Returns a loaded lib module or throws a clear error.
 * Why: one message tells the reader which file is missing and who builds it.
 * @param {keyof FILES} name
 */
export function libModule(name) {
  const module = loaded[name];
  if (!module) {
    throw new Error(
      `lib/${FILES[name]} is missing: it is built by the shared k6 library package (A1)`,
    );
  }
  return module;
}

/**
 * True when the lib module exists.
 * Why: unit tests skip lib-dependent cases (with a note) while A1 is still being built.
 * @param {keyof FILES} name
 * @returns {boolean}
 */
export function hasLib(name) {
  return Boolean(loaded[name]);
}

/** lib/duration.js parseDuration: "10m" → 600 (throws on garbage). */
export function parseDuration(text) {
  return libModule('duration').parseDuration(text);
}

/** lib/duration.js formatDuration: 600 → "10m 0s". */
export function formatDuration(seconds) {
  return libModule('duration').formatDuration(seconds);
}

/** lib/phase-plan.js buildPhasePlan (plan §4.1): the same schedule k6 runs. */
export function buildPhasePlan(input) {
  return libModule('phasePlan').buildPhasePlan(input);
}

/**
 * The measured phase of a phase plan (the phase the verdict is about).
 * Why: used everywhere; falls back to a local lookup so it works with any A1 version of the plan.
 * @param {{phases: Array<{name:string}>, measuredPhase: string}} phasePlan
 */
export function measuredPhaseOf(phasePlan) {
  return phasePlan.phases.find((phase) => phase.name === phasePlan.measuredPhase) ?? null;
}

/**
 * True for the summary-forcing rules ('count>=0', 'p(95)>=0', 'rate>=0', plan §4.2) that only make a
 * sub-metric appear in the k6 summary and are never reported.
 * Why: uses lib/thresholds.js when present; the local fallback applies the same rule ("<stat> >= 0").
 * @param {string} rule
 * @returns {boolean}
 */
export function isDummyRule(rule) {
  if (loaded.thresholds?.isDummyRule) return loaded.thresholds.isDummyRule(rule);
  return /^\s*(count|rate|p\(\d+(\.\d+)?\)|avg|med|min|max)\s*>=\s*0\s*$/.test(String(rule));
}

/**
 * Plain-language description of a k6 threshold rule (plan §4.2 describeThreshold).
 * Why: reports say "95 % of requests faster than 500 ms", not "p(95)<500". Falls back to a generic
 * sentence while lib/thresholds.js is missing.
 * @param {string} metricKey e.g. 'http_req_duration{scenario:measure}'
 * @param {string} rule e.g. 'p(95)<500'
 * @returns {{metric:string, rule:string, description:string, unit:string}}
 */
export function describeThreshold(metricKey, rule) {
  if (loaded.thresholds?.describeThreshold)
    return loaded.thresholds.describeThreshold(metricKey, rule);
  const metric = String(metricKey).split('{')[0];
  return { metric, rule, description: `${metricKey} ${rule}`, unit: '' };
}

/** lib/thresholds.js allowedDropped: floor(planned × rate); local fallback with the same formula. */
export function allowedDropped(plannedEvents, maxDroppedRate) {
  if (loaded.thresholds?.allowedDropped) {
    return loaded.thresholds.allowedDropped(plannedEvents, maxDroppedRate);
  }
  return Math.floor(plannedEvents * maxDroppedRate);
}
