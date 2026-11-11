/**
 * settings-fixture.mjs — typed settings for the lib unit tests (as tools/core/settings.mjs resolves them)
 *
 * What:    One object with every setting the pure lib modules read, at the defaults of plan §3.2, already
 *          in ResolvedSettings.values form (§3.3): durations in seconds, LEVELS as number[], unset = null.
 *          Derivation of *_EVENTS is NOT done here (that is A2's settings test): tests that need it pass
 *          the pre-derived duration, e.g. LOAD_DURATION: 20 "as if LOAD_EVENTS=1000 had been derived".
 * How:     import { settingsWith } from './settings-fixture.mjs'; settingsWith({ LOAD_DURATION: 20 })
 * Needs:   Nothing.
 * Outputs: Fresh settings objects (each call returns a new copy, so tests cannot affect each other).
 */

/** Defaults of plan §3.2 in their resolved (typed) form. */
const DEFAULTS = {
  PEAK_RATE: 50,
  SMOKE_RATE: 1,
  SMOKE_DURATION: 30,
  SMOKE_EVENTS: null,
  LOAD_RATE: 50,
  LOAD_DURATION: 600,
  LOAD_EVENTS: null,
  STRESS_RATE: 200,
  STRESS_DURATION: 600,
  STRESS_EVENTS: null,
  WARM_UP_RATE: 10,
  WARM_UP_DURATION: 60,
  LEVELS: [200, 400, 800, 1600, 3200, 6400],
  LEVEL_DURATION: 60,
  MATCHER_FLOOD_RATE: 2000,
  MATCHER_FLOOD_DURATION: 60,
  MATCHER_FLOOD_EVENTS: null,
  STEP_SLA_STORM_ALARMS: 100000,
  STEP_SLA_FIRST_RING_DELAY: 60,
  MAX_VUS: 2000,
  KAFKA_PRE_ALLOCATED_VUS: 100,
  KAFKA_MAX_VUS: 500,
  HTTP_P95_LIMIT_MS: 500,
  HTTP_MAX_FAILED_RATE: 0.01,
  MIN_CHECKS_RATE: 0.99,
  MAX_DROPPED_RATE: 0.001,
  BREAKPOINT_MAX_DROPPED: 1000,
  MATCHER_MAX_KAFKA_WRITE_ERRORS: 0,
  REPORT_WINDOW: 10,
  BREAKPOINT_CATCH_UP_LIMIT: 900,
  EVENT_SOURCE: null,
  FACILITY_ID: null,
  EVENT_ACTION_ID: null,
};

/**
 * Returns a fresh copy of the defaults with some settings changed.
 * Why: every test states only what it changes.
 * @param {Record<string, unknown>} [changes]
 * @returns {Record<string, unknown>}
 */
export function settingsWith(changes = {}) {
  return structuredClone({ ...DEFAULTS, ...changes });
}
