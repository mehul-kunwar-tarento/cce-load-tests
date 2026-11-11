/**
 * shared.mjs — the ONE door from the Step SLA test folder to the shared tooling of the repository.
 *
 * What:    The Step SLA tests reuse shared code (Postgres helpers, metric parsing, watcher building blocks,
 *          formatting, settings resolution). Every file of this folder imports that code from here, never
 *          from ../tools/… or ../lib/… directly. When the folder is copied into the cce-step-sla-service
 *          repository as performance-tests/, only this file has to point somewhere else (plan §6.4, §10.1).
 *          There is no k6 shim (tests/shared-lib.js): Step SLA is fed by seeded alarms, not by k6.
 * How:     import { withDedicatedClient, sumMetric } from '../shared.mjs';   (or './shared.mjs' at the top)
 * Needs:   The repository's tools/core/ modules (package A2) and lib/phase-plan.js (A1) next to this folder.
 * Outputs: Re-exports only; nothing runs when it is imported.
 */

// Errors: RefusedError makes the runner exit with code 2 ("refused") and a plain message.
export { RefusedError } from '../tools/core/errors.mjs';

// Postgres: one dedicated client for the seed transaction; queries with a statement timeout.
export { queryRows, withDedicatedClient } from '../tools/core/clients/postgres.mjs';

// Prometheus text (/actuator/prometheus): sum or max over series; null when a metric is absent.
// (parsePrometheusText: the unit tests build fake scrapes from Prometheus text with it.)
export {
  maxMetric,
  parsePrometheusText,
  sumMetric,
} from '../tools/core/clients/prometheus-text.mjs';

// Watcher building blocks: sample file written as it goes, restart and stall detection.
export { createSampleLog, createStallDetector, isCounterReset } from '../tools/core/watchers.mjs';

// "Is Step SLA idle?" before a run: cce_sla_transitions_due <= 0 for IDLE_FLAT_DURATION.
export { waitForStepSlaIdle } from '../tools/core/idle.mjs';

// Test-data ids: UUIDv7-shaped ids generated in SQL, and the UUIDv7 floor that bounds primary-key scans.
export { UUID_V7_SQL, uuidV7Floor } from '../tools/core/run-id.mjs';

// Index-friendly data-check queries with a statement timeout (plan §6.8).
export {
  DEFAULT_STATEMENT_TIMEOUT_MS,
  runTimedQuery,
  uuidV7LowerBound,
} from '../tools/core/run-sql.mjs';

// Environment: subject → environment key mapping ('step-sla' → services.stepSla).
export { loadEnvironment, serviceConfig } from '../tools/core/environment.mjs';

// The phase plan (PURE lib module, the same code the settings resolver uses): the expectation text reads the
// alarm count from it, so the printed expectation and the seeded count can never differ.
export { buildPhasePlan } from '../lib/phase-plan.js';

// Formatting and JSON files.
export { formatNumber, formatSeconds, toIsoWithOffset } from '../tools/core/format.mjs';
export { readJsonIfExists } from '../tools/core/results.mjs';

// Used by this folder's unit tests only: resolve settings exactly like `run` does, the shared ctx.times,
// the module validator and the result builder/validator (to prove a Step SLA result is a valid result.json).
export { buildRunContext, prepareRunSettings } from '../tools/core/run-setup.mjs';
export { createTimes } from '../tools/core/k6-clock.mjs';
export { validateServiceModule } from '../tools/core/service-registry.mjs';
export { buildResult } from '../tools/core/result-builder.mjs';
export { validateResult } from '../tools/core/result-schema.mjs';
