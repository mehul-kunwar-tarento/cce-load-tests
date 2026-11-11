/**
 * json-file.mjs — reads JSON files written by people, dropping the "$comment" header.
 *
 * What:    Our own JSON files (settings defaults, environments, datasets, baselines) start with a
 *          "$comment" key holding their header comment (plan §2.4). Every loader goes through
 *          readConfigJson, so no code ever sees "$comment" as a setting, an environment field or part
 *          of an event sent to a CCE service.
 * How:     import { readConfigJson } from './json-file.mjs'; const defaults = readConfigJson(file);
 * Needs:   A readable JSON file.
 * Outputs: The parsed object without its top-level "$comment"; a clear error naming the file when the
 *          JSON is invalid.
 */
import fs from 'node:fs';

/**
 * Reads and parses a JSON file as is.
 * Why: one place that turns a JSON syntax error into a message with the file name.
 * @param {string} file absolute or relative path
 * @returns {unknown}
 */
export function readJsonFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`, { cause: error });
  }
}

/**
 * Returns a shallow copy of an object without its top-level "$comment" key.
 * Why: the header is documentation, never data; nested "$comment"s are left for the owner of that
 * data (e.g. fillTemplate in lib/test-data.js drops them from event templates).
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function stripComment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  // Rest destructuring copies every other key and leaves the original untouched.
  // eslint-disable-next-line no-unused-vars
  const { $comment, ...rest } = value;
  return rest;
}

/**
 * Reads one of our JSON files and drops its "$comment" header.
 * Why: the ONLY way tools load hand-written JSON (plan §2.4).
 * @param {string} file
 * @returns {any}
 */
export function readConfigJson(file) {
  return stripComment(readJsonFile(file));
}
