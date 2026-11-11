/**
 * matcher-stress.test.js — k6 entry point of the matcher stress test.
 *
 * What:    Stress test: well above the peak (STRESS_RATE for STRESS_DURATION, default 200/s = 4 × peak for 10 min, after a warm-up). Shows whether and when the matcher starts falling behind, and whether it catches up.
 *          Everything an iteration does is in matcher-scenario.js; this file only wires it up.
 * How:     scripts/run-test.sh local matcher stress      (or: node tools/cli.mjs run local matcher stress)
 *          Never run k6 on this file by hand: it needs the run context the runner writes (RUN_CONTEXT).
 * Needs:   RUN_CONTEXT for subject matcher and test type stress; the image cce-load-tests/k6:2.3.0-kafka2.2.0.
 * Outputs: Kafka messages on cce.events.inbound; results/<run>/k6-summary.json (handleSummary).
 */
import { createMatcherTest } from './matcher-scenario.js';
import { markK6Start } from './shared-lib.js';

const matcher = createMatcherTest('stress');

/** k6 options: arrival-rate scenarios, Kafka VU limits, thresholds and tags, all from the run context. */
export const options = matcher.options;

/** "Time 0" of the phase plan (k6 clock contract): scenario start times count from the end of setup(). */
export function setup() {
  return markK6Start();
}

/** One iteration = one event for one new patient. */
export default function () {
  matcher.sendEvent();
}

/** Writes k6-summary.json (the JSON the result is built from) and a short text summary. */
export function handleSummary(data) {
  return matcher.writeSummary(data);
}
