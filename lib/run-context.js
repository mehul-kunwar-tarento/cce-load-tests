/**
 * run-context.js — loads the run context (settings, phase plan, dataset…) that Node prepared for k6 (K6)
 *
 * What:    k6 never reads settings from environment variables. Before starting k6, the Node runner
 *          (tools/commands/run-test.mjs) resolves every setting, computes the phase plan and writes
 *          results/<dir>/run-context.json (plan §3.5). k6 gets its path as `-e RUN_CONTEXT=/tests/…`.
 *          This module reads that file once per VU and hands it to the test.
 * How:     In a test file, at the top level (k6 "init context", where open() is allowed):
 *            import { getRunContext, assertRunContextFor } from '../../lib/run-context.js';
 *            const context = getRunContext();
 *            assertRunContextFor(context, { subject: 'collector', testType: 'load' });
 * Needs:   k6 (uses open() and __ENV); env var RUN_CONTEXT = absolute path of run-context.json inside
 *          the container (set by scripts/run-test.sh).
 * Outputs: The parsed run context object (plan §3.5), memoised.
 */

/** The parsed file, kept so later calls (setup, iterations, handleSummary) reuse it. */
let cached = null;

/**
 * Returns the run context, reading run-context.json on the first call.
 * Why: one place that knows where the context comes from and what to say when it is missing.
 * Must first be called in the init context (top level of the test file): k6 allows open() only there.
 * @returns {object} run context (plan §3.5)
 */
export function getRunContext() {
  if (cached) return cached;
  const path = __ENV.RUN_CONTEXT;
  if (!path) throw new Error('RUN_CONTEXT missing: run tests through scripts/run-test.sh');
  // open() resolves relative paths against this file, which is never what is meant: insist on absolute.
  if (!path.startsWith('/')) {
    throw new Error(
      `RUN_CONTEXT must be an absolute path inside the container, got "${path}": run tests through scripts/run-test.sh`,
    );
  }
  const parsed = JSON.parse(open(path));
  // Node already strips "$comment"; drop it again in case the file was written by hand.
  delete parsed.$comment;
  cached = parsed;
  return cached;
}

/**
 * Refuses to run a test file with a context made for another service or test type.
 * Why: running collector-load.test.js with a stress context would label a load run as stress.
 * @param {object} context run context
 * @param {{subject:string, testType:string}} expected what the test file is
 */
export function assertRunContextFor(context, { subject, testType }) {
  if (context.subject !== subject || context.testType !== testType) {
    throw new Error(
      `This test is ${subject} ${testType}, but the run context is for ${context.subject} ${context.testType}: ` +
        'run tests through scripts/run-test.sh',
    );
  }
}
