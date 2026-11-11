/**
 * logger.mjs — prefixed, timestamped console messages for long-running commands.
 *
 * What:    A run takes many minutes; every line says when it happened and which part said it
 *          ("14:22:33 [run] preflight passed"), so the console (and k6.log) can be read afterwards.
 * How:     import { createLogger } from './logger.mjs'; const log = createLogger('run'); log.info('…');
 * Needs:   Writable streams (default process.stdout / process.stderr; tests pass collectors).
 * Outputs: Lines on stdout (info) and stderr (warn, error); warnings are also kept in `log.warnings`.
 */
import { formatClock } from './format.mjs';

/**
 * Creates a logger.
 * Why: commands and service modules share one format; warnings are collected so the result builder
 * can copy them into result.json.
 * @param {string} prefix short name shown in brackets
 * @param {{stdout?: {write(s:string):void}, stderr?: {write(s:string):void}, now?: () => Date}} [options]
 * @returns {{info(m:string):void, warn(m:string):void, error(m:string):void, child(p:string):object, warnings:string[]}}
 */
export function createLogger(
  prefix,
  { stdout = process.stdout, stderr = process.stderr, now = () => new Date(), warnings = [] } = {},
) {
  const line = (message) => `${formatClock(now())} [${prefix}] ${message}\n`;
  return {
    warnings,
    info: (message) => stdout.write(line(message)),
    warn: (message) => {
      warnings.push(message);
      stderr.write(line(`WARNING: ${message}`));
    },
    error: (message) => stderr.write(line(`ERROR: ${message}`)),
    // A child shares the warnings list, so warnings of watchers end up in the same result.
    child: (childPrefix) => createLogger(childPrefix, { stdout, stderr, now, warnings }),
  };
}
