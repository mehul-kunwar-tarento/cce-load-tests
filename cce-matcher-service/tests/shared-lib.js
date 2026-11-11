/**
 * shared-lib.js — the ONE door from the matcher k6 tests to the shared k6 library (lib/).
 *
 * What:    k6 test files in this folder import shared k6 code only through this file (plan §6.4, §10.1),
 *          so when the folder is copied into the cce-matcher-service repository as `performance-tests/`,
 *          only this file (and ../shared.mjs for Node) needs new paths. It re-exports what a Kafka test needs:
 *          the run context Node prepared, k6 options, iteration tagging, the event builder, the Kafka
 *          producer, the events_sent/events_accepted counters and the summary writer.
 * How:     import { getRunContext, buildOptions, createProducer } from './shared-lib.js';
 *          Runs inside k6 only (some modules import k6 and k6/x/kafka).
 * Needs:   ../../lib/*.js and the image cce-load-tests/k6:2.3.0-kafka2.2.0 (xk6-kafka built in).
 * Outputs: Re-exports only; no code of its own.
 */

// Run context written by the Node runner (results/<dir>/run-context.json, plan §3.5).
export { assertRunContextFor, getRunContext } from '../../lib/run-context.js';

// k6 options: arrival-rate scenarios, Kafka VU limits, thresholds, tags (plan §4.3).
export { buildOptions } from '../../lib/scenarios.js';

// Per-iteration tags phase / window, used by the "when did it start breaking" analysis (plan §4.7).
export { tagIteration } from '../../lib/tagging.js';

// LOADTEST-<runId>-mat-… ids and the CloudEvent built from the dataset template (plan §2.3, §4.6).
export { buildIterationEvent } from '../../lib/test-data.js';

// One xk6-kafka producer per VU and one message per call (plan §4.7).
export { createProducer, produceEvent } from '../../lib/kafka-client.js';

// The events_sent / events_accepted counters (names are part of the result contract).
export { recordSend } from '../../lib/event-metrics.js';

// setup() time stamp ("time 0") and handleSummary output (k6-summary.json + short text).
export { markK6Start, writeSummary } from '../../lib/summary.js';
