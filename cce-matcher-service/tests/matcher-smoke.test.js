/**
 * matcher-smoke.test.js — k6 entry point of the matcher smoke test.
 *
 * What:    Smoke test: a few events (SMOKE_RATE for SMOKE_DURATION, default 1/s for 30 s) prove the whole path works before any bigger test: written to Kafka, logged, matched and enrolled by the matcher.
 *          Everything an iteration does is in matcher-scenario.js; this file only wires it up.
 * How:     scripts/run-test.sh local matcher smoke      (or: node tools/cli.mjs run local matcher smoke)
 *          Never run k6 on this file by hand: it needs the run context the runner writes (RUN_CONTEXT).
 * Needs:   RUN_CONTEXT for subject matcher and test type smoke; the image cce-load-tests/k6:2.3.0-kafka2.2.0.
 * Outputs: Kafka messages on cce.events.inbound; results/<run>/k6-summary.json (handleSummary).
 */
import { createMatcherTest } from './matcher-scenario.js';
import { markK6Start } from './shared-lib.js';

const matcher = createMatcherTest('smoke');

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
