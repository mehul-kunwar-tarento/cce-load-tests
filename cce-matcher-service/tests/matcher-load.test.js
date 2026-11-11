/**
 * matcher-load.test.js — k6 entry point of the matcher load test.
 *
 * What:    Load test: the expected peak (LOAD_RATE for LOAD_DURATION, default 50/s for 10 min, after a WARM_UP_RATE warm-up). Passes when the backlog stays low and clears quickly after sending stops.
 *          Everything an iteration does is in matcher-scenario.js; this file only wires it up.
 * How:     scripts/run-test.sh local matcher load      (or: node tools/cli.mjs run local matcher load)
 *          Never run k6 on this file by hand: it needs the run context the runner writes (RUN_CONTEXT).
 * Needs:   RUN_CONTEXT for subject matcher and test type load; the image cce-load-tests/k6:2.3.0-kafka2.2.0.
 * Outputs: Kafka messages on cce.events.inbound; results/<run>/k6-summary.json (handleSummary).
 */
import { createMatcherTest } from './matcher-scenario.js';
import { markK6Start } from './shared-lib.js';

const matcher = createMatcherTest('load');

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
