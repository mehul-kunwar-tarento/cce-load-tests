/**
 * command-args.mjs — argument parsing shared by every CLI command (node:util parseArgs).
 *
 * What:    Every command accepts options the same way (--set NAME=value repeated, --json, --help …).
 *          This wrapper turns parseArgs' errors ("Unknown option '--sett'") into a UsageError, so the
 *          CLI prints the message and the command's usage and exits with 2 (plan §5.7).
 * How:     const { values, positionals } = parseCommandArgs(argv, { json: { type: 'boolean' } });
 * Needs:   Nothing.
 * Outputs: { values, positionals }.
 */
import { parseArgs } from 'node:util';
import { UsageError } from './errors.mjs';

/** Options every command understands. */
const COMMON_OPTIONS = { help: { type: 'boolean', short: 'h' } };

/**
 * Parses a command's arguments strictly.
 * Why: a typo in an option must stop the command, not be silently ignored.
 * @param {string[]} argv arguments after the command name
 * @param {Record<string, {type:'string'|'boolean', multiple?:boolean, short?:string, default?:any}>} options
 * @returns {{values: Record<string, any>, positionals: string[]}}
 */
export function parseCommandArgs(argv, options = {}) {
  try {
    return parseArgs({
      args: argv,
      options: { ...COMMON_OPTIONS, ...options },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(error.message);
  }
}
