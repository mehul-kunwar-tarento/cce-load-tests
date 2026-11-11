/**
 * shared.mjs — the ONE door from this folder (Node side) to the shared tooling and library.
 *
 * What:    The collector folder is meant to be copied into the cce-collector-service repository later
 *          (as performance-tests/). To make that a two-file job, every Node file in this folder imports
 *          shared code only through this shim: the Node core (tools/core/: idle checks, run-selection SQL,
 *          k6-summary reading, breaking analysis, formatting) and the PURE modules of the k6 library
 *          (lib/: phase plan, durations) — the same code k6 runs. The k6 side has its own shim,
 *          tests/shared-lib.js. A unit test (unit-tests/import-boundary.spec.mjs) enforces the rule.
 * How:     import { waitForMatcherIdle, candidateEventIdsSql } from './shared.mjs';        (folder root)
 *          import { resolveSettings } from '../shared.mjs';                                (unit-tests/)
 *          After copying the folder elsewhere, change only the paths below.
 * Needs:   ../tools/core/*.mjs (package A2) and ../lib/*.js pure modules (package A1).
 * Outputs: Re-exported functions and constants; no code of its own.
 */

// "Is the matcher idle?" and its current backlog: collector events also feed the matcher (plan §6.6).
export { readMatcherBacklog, waitForMatcherIdle } from '../tools/core/idle.mjs';

// Index-friendly SQL that selects one run's rows (generated candidate ids, statement timeout; plan §6.8).
export {
  candidateEventIdsSql,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  runTimedQuery,
} from '../tools/core/run-sql.mjs';

// Reading k6's end-of-test summary (both threshold shapes) and single values from it (plan §5.3).
export { metricValue, normaliseK6Summary } from '../tools/core/k6-summary.mjs';

// "When did it start breaking / held up to" — the same analysis the result builder runs (plan §6.9).
export { analyseLevels, analyseWindows, measuredP95 } from '../tools/core/breaking-analysis.mjs';

// Result files and number formatting for plain-language notes.
export { readJsonIfExists } from '../tools/core/results.mjs';
export { formatNumber, formatPercent } from '../tools/core/format.mjs';

// PURE k6-library modules (no k6 imports): phase plan and durations, identical in k6 and Node (plan §4).
export { buildPhasePlan, measuredPhaseOf } from '../lib/phase-plan.js';
export { formatDuration } from '../lib/duration.js';

// Used by this folder's unit tests only: real settings resolution, dataset loading, the registry's shape
// check and the result builder + schema check, so the tests follow config/settings/defaults.json, the
// test-data and the module contract instead of copies of them.
export { resolveSettings } from '../tools/core/settings.mjs';
export { loadDataset } from '../tools/core/run-setup.mjs';
export { validateServiceModule } from '../tools/core/service-registry.mjs';
export { buildResult } from '../tools/core/result-builder.mjs';
export { validateResult } from '../tools/core/result-schema.mjs';
