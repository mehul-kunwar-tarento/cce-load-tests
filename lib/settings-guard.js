/**
 * settings-guard.js — checks that a resolved setting has the type the shared library expects (PURE)
 *
 * What:    The library never parses settings itself: Node (tools/core/settings.mjs) has already turned
 *          "10m" into 600 and "200,400" into [200, 400]. These small guards read one setting and stop
 *          with a clear message when it is missing or still text, so a wiring mistake shows up at once
 *          instead of producing a silent 0-second phase.
 * How:     import { requireNumber, requireRate } from './settings-guard.js'; used by phase-plan.js,
 *          thresholds.js and scenarios.js.
 * Needs:   `settings` = ResolvedSettings.values (plan §3.3): durations are numbers of seconds, LEVELS is
 *          number[], unset settings are null.
 * Outputs: The checked value, or an Error naming the setting.
 */

/**
 * Reads a setting that must be a finite number (seconds, a ratio, a count).
 * Why: catches a duration that arrived as "10m" (string) instead of 600 (seconds).
 * @param {Record<string, unknown>} settings ResolvedSettings.values
 * @param {string} name setting name, e.g. 'LOAD_DURATION'
 * @param {{min?: number}} [limits]
 * @returns {number}
 */
export function requireNumber(settings, name, { min = -Infinity } = {}) {
  const value = settings ? settings[name] : undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `Setting ${name} must be a number (durations in seconds), got ${JSON.stringify(value)}: ` +
        'settings are resolved by tools/core/settings.mjs; run tests through scripts/run-test.sh',
    );
  }
  if (value < min) throw new Error(`Setting ${name} must be at least ${min}, got ${value}`);
  return value;
}

/**
 * Reads a setting that must be a whole number (counts such as MAX_VUS).
 * Why: k6 refuses fractional VU counts; better to say so with the setting's name.
 * @returns {number}
 */
export function requireInteger(settings, name, { min = -Infinity } = {}) {
  const value = requireNumber(settings, name, { min });
  if (!Number.isInteger(value))
    throw new Error(`Setting ${name} must be a whole number, got ${value}`);
  return value;
}

/**
 * Reads a rate setting (events per second, a whole number ≥ 1, plan §3.2).
 * Why: arrival-rate executors need a positive whole rate.
 * @returns {number}
 */
export function requireRate(settings, name) {
  return requireInteger(settings, name, { min: 1 });
}

/**
 * Reads a list of rates such as LEVELS ([200, 400, 800]), strictly ascending.
 * Why: a staircase that goes down or repeats a level would make "held up to / broke at" meaningless.
 * @returns {number[]}
 */
export function requireRateList(settings, name) {
  const value = settings ? settings[name] : undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `Setting ${name} must be a non-empty list of rates, got ${JSON.stringify(value)}`,
    );
  }
  value.forEach((rate, i) => {
    if (!Number.isInteger(rate) || rate < 1) {
      throw new Error(
        `Setting ${name}[${i}] must be a whole rate ≥ 1, got ${JSON.stringify(rate)}`,
      );
    }
    // Each level must be higher than the one before it.
    if (i > 0 && rate <= value[i - 1]) {
      throw new Error(`Setting ${name} must be strictly ascending, got ${value.join(',')}`);
    }
  });
  return value;
}
