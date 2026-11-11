/**
 * duration.js — parse and format durations such as "90s", "10m", "1h30m" or "500ms" (PURE)
 *
 * What:    Testers type durations as text ("10m"); the code works in plain seconds. This module turns
 *          text into seconds (and refuses anything it does not understand, instead of silently
 *          using 0 as the first version did), and seconds back into readable or k6-style text.
 * How:     import { parseDuration, formatDuration, toK6Duration } from '../lib/duration.js';
 *          Used by tools/core/settings.mjs (Node) and by lib/scenarios.js (k6).
 * Needs:   Nothing (no k6 imports, no file access), so Node and k6 can both load it.
 * Outputs: Numbers of seconds (parseDuration) and strings (formatDuration, toK6Duration).
 */

/** Seconds per unit letter, so "1h30m" can be added up unit by unit. */
const UNIT_SECONDS = { h: 3600, m: 60, s: 1, ms: 0.001 };

/** One "<number><unit>" piece of a duration, e.g. "30m" or "1.5s"; "ms" is tried before "m". */
const PART = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;

/**
 * Turns a duration written by a person into seconds.
 * Why: every setting of type "duration" goes through here once (in Node), so a typo such as "10 min"
 * stops the run with a clear message instead of becoming a 0-second test.
 * @param {string|number} text e.g. "90s", "10m", "1h30m", "1m30s", "500ms", "45" (plain = seconds) or 45
 * @returns {number} seconds (may be fractional, e.g. 0.5 for "500ms")
 */
export function parseDuration(text) {
  // A number that is already seconds (e.g. from JSON) is accepted as it is, if it is valid.
  if (typeof text === 'number') {
    if (Number.isFinite(text) && text >= 0) return text;
    throw invalid(text);
  }
  if (typeof text !== 'string') throw invalid(text);
  const value = text.trim();
  // Plain digits mean seconds ("45" = 45 s), the same as k6's own rule for bare numbers.
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value === '') throw invalid(text);

  let seconds = 0;
  let consumed = '';
  const seen = new Set();
  for (const match of value.matchAll(PART)) {
    const [whole, amount, unit] = match;
    // Each unit may appear once ("1m1m" is a typo, not 2 minutes).
    if (seen.has(unit)) throw invalid(text);
    seen.add(unit);
    seconds += Number(amount) * UNIT_SECONDS[unit];
    consumed += whole;
  }
  // Everything must have been understood: "10 min" or "10x" leave characters unconsumed.
  if (consumed !== value) throw invalid(text);
  // Round away floating-point noise such as 0.30000000000000004 from "300ms".
  return Math.round(seconds * 1e6) / 1e6;
}

/**
 * Formats seconds for people, e.g. 600 → "10m 0s", 30 → "30s", 5400 → "1h 30m 0s", 0.2 → "200ms".
 * Why: settings printouts and reports show durations the way testers type them.
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) throw invalid(seconds);
  // Under a second: milliseconds read better than "0.2s".
  if (seconds > 0 && seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  // Keep up to 3 decimals for fractional seconds (e.g. "1.5s"), without trailing noise.
  const rest = Math.round((seconds % 60) * 1000) / 1000;
  if (hours > 0) return `${hours}h ${minutes}m ${rest}s`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

/**
 * Formats seconds the way k6 options expect them, e.g. 600 → "600s", 0.2 → "200ms", 20.0195 → "20019500us".
 * Why: scenario startTime/duration and stage durations are strings in k6; whole seconds, whole
 * milliseconds or whole microseconds are always accepted by k6's parser, whatever the size. Microseconds
 * are needed when a phase must stop between two event starts that are less than a millisecond apart
 * (e.g. an exact event total at 2,000/s, see lib/scenarios.js).
 * @param {number} seconds
 * @returns {string}
 */
export function toK6Duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) throw invalid(seconds);
  if (Number.isInteger(seconds)) return `${seconds}s`;
  const micros = Math.round(seconds * 1e6);
  // Whole milliseconds read better ("59500ms"); anything finer is written in microseconds.
  if (micros % 1000 === 0) return `${micros / 1000}ms`;
  return `${micros}us`;
}

/** Builds the one error message every bad duration gets, so testers see the same hint everywhere. */
function invalid(text) {
  return new Error(`Invalid duration "${text}": use e.g. 30s, 10m, 1h30m`);
}
