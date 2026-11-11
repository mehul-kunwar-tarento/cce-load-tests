/**
 * collector-breakpoint.test.js — collector breakpoint test: k6 posts CloudEvents to POST /v1/events.
 *
 * What:    Finds the highest rate the collector holds: after the warm-up, a staircase over LEVELS (default
 *          200,400,800,1600,3200,6400/s), LEVEL_DURATION (1m) each; it stops at the first level that breaks
 *          (p95, errors, checks, or k6 could not send on time). Report: held up to X/s, broke at Y/s.
 *          Open load model: k6 starts iterations at the planned rate whether or not the collector keeps
 *          up; late ones are "dropped iterations" (reported exactly; the staircase stops after BREAKPOINT_MAX_DROPPED).
 * How:     scripts/run-test.sh local collector breakpoint        (or: node tools/cli.mjs run local collector breakpoint)
 *          Narrow it down: scripts/run-test.sh local collector breakpoint --refine-from results/collector-breakpoint-<stamp>
 *          (finer levels between held and broke, warm-up at the last good level).
 *          Never run k6 on this file directly: the runner writes run-context.json and passes RUN_CONTEXT.
 * Needs:   RUN_CONTEXT (run-context.json from the runner, subject collector, test type breakpoint); the collector
 *          reachable at environment.services.collector.baseUrl; the k6 image cce-load-tests/k6:2.3.0-kafka2.2.0.
 * Outputs: k6 metrics (http_req_*, checks, events_sent / events_accepted, dropped_iterations), tagged with
 *          testid / service / test_type (Prometheus remote write when monitoring is on), and
 *          <results dir>/k6-summary.json (handleSummary) for result.json.
 */
import {
  assertRunContextFor,
  buildOptions,
  getRunContext,
  markK6Start,
  writeSummary,
} from './shared-lib.js';
import { createCollectorIteration } from './collector-scenario.js';

// Init context (runs once per VU before the test): read the run context and refuse a mismatching one.
const context = getRunContext();
assertRunContextFor(context, { subject: 'collector', testType: 'breakpoint' });

/** k6 options: arrival-rate scenarios, thresholds and tags, all from the run context (no env vars). */
export const options = buildOptions({ context, kind: 'http' });

/** "Time 0" of the phase plan (k6 clock contract): runs after every VU is initialised. */
export function setup() {
  return markK6Start();
}

/** One iteration = one new event posted to the collector (tests/collector-scenario.js). */
export default createCollectorIteration(context);

/** Writes k6-summary.json into the results folder and a short text to stdout. */
export function handleSummary(data) {
  return writeSummary(data, context);
}
