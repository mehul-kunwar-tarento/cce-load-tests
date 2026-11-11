/**
 * shared-lib.js — the ONE door from this folder's k6 scripts to the shared k6 library (lib/).
 *
 * What:    Every collector k6 script imports library code only through this file, so the folder can be
 *          copied into the cce-collector-service repository later (as performance-tests/) by changing the
 *          paths here and nowhere else. It re-exports: the run context (settings, phase plan and dataset
 *          prepared by the Node runner), the k6 options builder (arrival-rate scenarios, thresholds, tags),
 *          iteration tagging, test-data builders (ids, FHIR resource, CloudEvent), the HTTP helpers, the
 *          event counters and the summary writer.
 * How:     import { getRunContext, buildOptions } from './shared-lib.js';   (inside tests/)
 * Needs:   k6 (the library's K6 modules import k6, k6/http, k6/metrics, k6/execution); ../../lib/*.js (package A1).
 * Outputs: Re-exported functions and counters; no code of its own.
 */

// Run context: the JSON the Node runner wrote for this run (RUN_CONTEXT); refuses a context for another test.
export { assertRunContextFor, getRunContext } from '../../lib/run-context.js';

// k6 options from the phase plan: scenarios smoke / warm-up / measure, thresholds, summary stats, tags.
export { buildOptions } from '../../lib/scenarios.js';

// Tags each iteration with phase, staircase level and report window ("when did it start breaking").
export { tagIteration } from '../../lib/tagging.js';

// Test data: LOADTEST-<runId>-col-… ids (≤ 50 chars), dataset template → FHIR resource → CloudEvent.
export {
  buildCloudEvent,
  buildCorrelationId,
  buildEventId,
  buildFhirResource,
  buildPatientId,
  eventDefaults,
} from '../../lib/test-data.js';

// HTTP: JSON POST with a fixed name tag, named checks.
export { checkResponse, jsonFieldEquals, postJson, statusIs } from '../../lib/http-client.js';

// Counters events_sent / events_accepted (part of the result contract).
export { recordSend } from '../../lib/event-metrics.js';

// "Time 0" of the phase plan (k6 clock contract) and the end-of-test summary file.
export { markK6Start, writeSummary } from '../../lib/summary.js';
