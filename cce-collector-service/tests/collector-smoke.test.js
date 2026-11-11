/**
 * collector-smoke.test.js — collector smoke test: k6 posts CloudEvents to POST /v1/events.
 *
 * What:    Proves the whole path works before a bigger test: SMOKE_RATE (default 1/s) for SMOKE_DURATION
 *          (default 30s), no warm-up; the first failed check stops it (abort rule). Every event must be
 *          answered 202 "accepted" and stored.
 *          Open load model: k6 starts iterations at the planned rate whether or not the collector keeps
 *          up; late ones are "dropped iterations" (reported exactly; < 0.1 % allowed, to be confirmed by team).
 * How:     scripts/run-test.sh local collector smoke        (or: node tools/cli.mjs run local collector smoke)
 *          Change the amount: --set SMOKE_RATE=2 --set SMOKE_EVENTS=60 (duration derived).
 *          Never run k6 on this file directly: the runner writes run-context.json and passes RUN_CONTEXT.
 * Needs:   RUN_CONTEXT (run-context.json from the runner, subject collector, test type smoke); the collector
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
assertRunContextFor(context, { subject: 'collector', testType: 'smoke' });

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
