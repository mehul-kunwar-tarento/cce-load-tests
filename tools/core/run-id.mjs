/**
 * run-id.mjs — run IDs and the test-data selectors built from them (plan §2.3).
 *
 * What:    Every run has an ID (default yyyymmdd-hhmmss, e.g. 20261105-142233). All test data of the
 *          run carries it (LOADTEST-<runId>-<idCode>-…), so data checks and cleanup find exactly that
 *          run's rows. Selectors always end with the id code ("col", "mat", "sla"), so one run's
 *          selector can never match another run's ids. Rows that CCE itself creates have UUIDv7 ids
 *          (time-ordered); uuidV7Floor gives the smallest id of a moment, so queries can skip older rows.
 * How:     import { createRunId, validateRunId, runSelectors, uuidV7Floor } from './run-id.mjs';
 * Needs:   Nothing.
 * Outputs: Strings (ids, selectors, UUIDs, an SQL expression).
 */
import { RefusedError } from './errors.mjs';
import { formatStamp } from './format.mjs';

/** Default run id shape: local date and time of the run start. */
const DEFAULT_RUN_ID = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;

/** Custom run ids: 1–20 letters/digits, no hyphen or underscore (LIKE needs no escaping, §2.3). */
const CUSTOM_RUN_ID = /^[A-Za-z0-9]{1,20}$/;

/** Id codes of the in-scope services, used in test-data ids (plan §2.1). */
export const ID_CODES = ['col', 'mat', 'sla'];

/**
 * A new default run id from a moment (local time).
 * Why: sortable, readable, and carries the year (v1 ids "mmddHHMMSS" did not).
 * @param {Date} [date]
 * @returns {string} e.g. '20261105-142233'
 */
export function createRunId(date = new Date()) {
  return formatStamp(date);
}

/**
 * Checks a run id; throws RefusedError when it is not allowed.
 * Why: a hyphen inside a custom id ("test-2") would let one run's selector match another run's data.
 * @param {string} runId
 */
export function validateRunId(runId) {
  if (typeof runId !== 'string' || !(DEFAULT_RUN_ID.test(runId) || CUSTOM_RUN_ID.test(runId))) {
    throw new RefusedError(
      `RUN_ID "${runId}" is not allowed: use the default yyyymmdd-hhmmss or 1-20 letters/digits ` +
        '(no hyphen, no underscore), e.g. RUN_ID=baseline1',
    );
  }
}

/**
 * True when the id has the default yyyymmdd-hhmmss shape.
 * Why: only default ids tell when the run started (bounds for UUIDv7 scans).
 * @param {string} runId
 * @returns {boolean}
 */
export function isDefaultRunId(runId) {
  return DEFAULT_RUN_ID.test(String(runId));
}

/**
 * Start time encoded in a default run id (read as THIS machine's local time), or null for custom/legacy ids.
 * Why: a readable start for ids made on this machine. For scan bounds when the run may have been made in
 *      another time zone, use runIdEarliestStart.
 * @param {string} runId
 * @returns {Date|null}
 */
export function runIdStart(runId) {
  const match = DEFAULT_RUN_ID.exec(String(runId));
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const date = new Date(y, mo - 1, d, h, mi, s);
  // Reject impossible dates such as month 13 (Date would silently roll over).
  return date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
}

/** Largest time-zone offset ahead of UTC (+14:00, Line Islands), in milliseconds. */
export const MAX_ZONE_AHEAD_MS = 14 * 3600_000;

/**
 * The earliest instant a default run id can stand for, whatever the time zone of the machine that ran it.
 * Why: the id is the run host's LOCAL wall clock. When run-context.json is not on this machine (Dev/UAT,
 *      k6 on another host), reading the id in this machine's zone can place the start hours after the real
 *      rows (run on an IST laptop, cleaned from a UTC host). Reading the wall clock as UTC and going back
 *      14 h (the largest offset ahead of UTC) is never later than the real start, in any zone.
 * @param {string} runId
 * @returns {Date|null} null for custom/legacy ids
 */
export function runIdEarliestStart(runId) {
  const match = DEFAULT_RUN_ID.exec(String(runId));
  if (!match || !runIdStart(runId)) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s) - MAX_ZONE_AHEAD_MS);
}

/**
 * Test-data prefix of a run: 'LOADTEST-<runId>-'.
 * Why: one spelling for every place that builds or matches test ids.
 * @param {string} runId
 * @returns {string}
 */
export function testDataPrefix(runId) {
  return `LOADTEST-${runId}-`;
}

/**
 * Selectors of a run, one per id code: 'LOADTEST-<runId>-<idCode>-'.
 * Why: they always end with the id code, so 'test' never matches 'test2' and '20261105' never
 * matches '20261105-142233' (the next segment differs) — plan §2.3.
 * @param {string} runId
 * @param {string[]} [idCodes]
 * @returns {string[]}
 */
export function runSelectors(runId, idCodes = ID_CODES) {
  validateRunId(runId);
  return idCodes.map((idCode) => `${testDataPrefix(runId)}${idCode}-`);
}

/**
 * Smallest UUIDv7 of a moment: 48-bit millisecond timestamp, version 7, variant bits, rest zero.
 * Why: every UUIDv7 created at or after `date` sorts >= this value, so `id >= floor` uses the primary
 * key index to skip older rows (plan §2.3, §6.8).
 * @param {Date|number|string} date
 * @returns {string} e.g. '0192f3a1-2b3c-7000-8000-000000000000'
 */
export function uuidV7Floor(date) {
  const ms = new Date(date).getTime();
  if (!Number.isFinite(ms) || ms < 0)
    throw new Error(`uuidV7Floor needs a valid date, got ${date}`);
  const hex = ms.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
}

/**
 * SQL expression that creates a UUIDv7-shaped id from clock_timestamp() plus random bits.
 * Why: seeded Step SLA rows get time-ordered ids like the ones CCE creates, so the uuidV7Floor bound
 * also finds them (v1 seeded random v4 ids). How it works: take a random v4 UUID, overwrite its first
 * 6 bytes with the millisecond timestamp, then set bits 52 and 53 to turn version 4 (0100) into 7 (0111).
 * Needs Postgres 13+ (gen_random_uuid built in).
 */
export const UUID_V7_SQL =
  'encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) placing ' +
  'substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3) ' +
  "from 1 for 6), 52, 1), 53, 1), 'hex')::uuid";
