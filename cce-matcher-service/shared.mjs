/**
 * shared.mjs — the ONE door from the matcher test folder (Node side) to the shared suite code.
 *
 * What:    The matcher folder is meant to be copied one day into the cce-matcher-service repository as
 *          `performance-tests/`. To make that a small job, every Node file in this folder imports shared
 *          code only through this file (plan §6.4, §10.1). It re-exports the pieces of the shared tooling
 *          (tools/core, tools/plan-definitions) and of the pure k6 library (lib/) that the matcher module,
 *          watcher, data checks and unit tests use. After copying, only this file (and tests/shared-lib.js
 *          for k6) needs new paths.
 * How:     import { waitForMatcherIdle, sumMetric } from './shared.mjs';          (folder root)
 *          import { createSampleLog } from '../shared.mjs';                       (sub-folders)
 * Needs:   The shared suite: ../tools/core/*.mjs, ../tools/plan-definitions/*.mjs, ../lib/*.js (pure modules).
 * Outputs: Re-exports only; no code of its own.
 */

// Idle and backlog helpers (plan §6.3 idle.mjs): the matcher must be idle before a run starts.
export { readMatcherBacklog, waitForMatcherIdle } from '../tools/core/idle.mjs';

// Watcher building blocks (plan §6.5): append-as-you-go sample file, counter reset, stall detection.
export { createSampleLog, createStallDetector, isCounterReset } from '../tools/core/watchers.mjs';

// "When did it start breaking" from the backlog series (plan §6.9).
export { analyseBacklogSeries } from '../tools/core/breaking-analysis.mjs';

// Index-friendly run selection SQL with statement_timeout (plan §6.8). candidatePhasePlan adds the
// 1 % + 10 margin per phase (k6 may start an iteration or two more than planned at a phase edge).
export {
  CANDIDATE_MARGIN,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  candidateEventIdsSql,
  candidatePhasePlan,
  runTimedQuery,
  uuidV7LowerBound,
} from '../tools/core/run-sql.mjs';

// Prometheus text parsing: sums over EVERY series, null when absent (fixes v1's first-series regex).
export {
  maxMetric,
  parsePrometheusText,
  sumMetric,
} from '../tools/core/clients/prometheus-text.mjs';

// Reading the k6 summary written by handleSummary (e.g. kafka_writer_message_count).
export { metricValue, normaliseK6Summary } from '../tools/core/k6-summary.mjs';

// Number and time formatting for plain-language descriptions.
export { formatNumber, formatSeconds, toIsoWithOffset } from '../tools/core/format.mjs';

// result.json assembly and its shape check (unit tests prove the watcher outcome fits the contract).
export { buildResult } from '../tools/core/result-builder.mjs';
export { validateResult } from '../tools/core/result-schema.mjs';

// Metrics every module gets sampled, and the fixed peaks table (unit tests check our keys fit them).
export { COMMON_SAMPLED_METRICS, PEAK_SIGNALS } from '../tools/core/sampled-metrics.mjs';

// The registry's shape check of a service module (unit tests prove this module passes it).
export { validateServiceModule } from '../tools/core/service-registry.mjs';

// Reading a JSON file of the results folder (null when it does not exist).
export { readJsonIfExists } from '../tools/core/results.mjs';

// Plan-definition sets: expected rows per event (plan §7.3) and set loading (unit tests).
export { computeExpectedRows } from '../tools/plan-definitions/expected-rows.mjs';
export { loadPlanDefinitionSet } from '../tools/plan-definitions/sets.mjs';

// Pure k6 library modules, the same code k6 runs (plan §4): phase plan, options/VUs, durations.
export { buildPhasePlan, measuredPhaseOf } from '../lib/phase-plan.js';
export { buildOptions, vusFor } from '../lib/scenarios.js';
export { formatDuration } from '../lib/duration.js';
