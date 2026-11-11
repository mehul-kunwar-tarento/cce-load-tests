/**
 * errors.mjs — the error types that decide a command's exit code (plan §5.7).
 *
 * What:    0 = passed/done, 1 = a test or data check failed, 2 = refused (prod, preflight failed, a
 *          guard, idle timeout, bad settings or arguments), 3 = tool error (a bug or an unexpected
 *          failure). Throwing RefusedError anywhere makes the CLI exit with 2 and print only the message.
 * How:     import { RefusedError, exitCodeFor, EXIT } from './errors.mjs';
 * Needs:   Nothing.
 * Outputs: Error classes and the exit-code constants.
 */

/** Exit codes shared by every command (plan §5.7). */
export const EXIT = Object.freeze({ OK: 0, FAILED: 1, REFUSED: 2, TOOL_ERROR: 3 });

/**
 * A deliberate "no": the tool will not do this (prod environment, bad setting, guard failed …).
 * Why: separates "we refused, read the message" (exit 2) from "something crashed" (exit 3).
 */
export class RefusedError extends Error {
  /** @param {string} message plain-language reason, printed as is */
  constructor(message) {
    super(message);
    this.name = 'RefusedError';
    this.exitCode = EXIT.REFUSED;
  }
}

/**
 * Wrong command-line usage (unknown option, missing argument).
 * Why: also exit 2, but the CLI prints the command's usage text after the message.
 */
export class UsageError extends RefusedError {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * Exit code for an error thrown by a command.
 * Why: one place maps error types to plan §5.7 codes.
 * @param {unknown} error
 * @returns {number}
 */
export function exitCodeFor(error) {
  return error instanceof RefusedError ? EXIT.REFUSED : EXIT.TOOL_ERROR;
}
