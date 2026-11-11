/**
 * scenarios.js — turns the phase plan into k6 options: scenarios, thresholds, tags (PURE)
 *
 * What:    k6 runs "scenarios". We only use arrival-rate executors (the "open" load model): k6 starts
 *          a new iteration (= one event) every 1/rate seconds whether or not the previous answer has
 *          arrived, just like real clients do. If the service slows down, k6 needs more virtual users
 *          (VUs) in flight; if it runs out of VUs, it "drops" iterations and counts them. This module
 *          picks the executor, start time, duration and VU numbers for every phase (plan §4.3).
 * How:     In a test file:  export const options = buildOptions({ context, kind: 'http' });
 *          Node can import it too (e.g. to print the k6 options of a dry run).
 * Needs:   A run context (plan §3.5: settings, phasePlan, runId, subject, testType, environment,
 *          planDefinitionSet) or a PhasePlan from lib/phase-plan.js.
 * Outputs: The k6 `options` object (scenarios, thresholds, summaryTrendStats, tags). A constant phase
 *          with a fractional duration (from an event total) gets a k6 duration that starts exactly
 *          its planned events (k6ConstantSeconds).
 */

import { toK6Duration } from './duration.js';
import { buildThresholds } from './thresholds.js';
import { requireInteger } from './settings-guard.js';

/** Statistics k6 keeps for every trend metric (latency etc.) in its end-of-test summary. */
export const SUMMARY_TREND_STATS = ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'];

/**
 * VUs for one rate (plan §4.3).
 * Why: too few VUs and k6 drops iterations at the first slow answer; too many and the load generator
 * wastes memory. HTTP: ready = half the rate, up to 4 × the rate (at least 50), never above MAX_VUS.
 * Kafka: every VU owns a librdkafka producer (threads + buffers), so its own, smaller limits apply and
 * MAX_VUS is never used.
 * @param {number} rate events per second
 * @param {{kind:'http'|'kafka', maxVus?:number, kafkaPreAllocatedVus?:number, kafkaMaxVus?:number}} limits
 * @returns {{preAllocatedVUs:number, maxVUs:number}}
 */
export function vusFor(rate, { kind, maxVus, kafkaPreAllocatedVus, kafkaMaxVus }) {
  if (kind === 'kafka') {
    const preAllocatedVUs = Math.min(kafkaPreAllocatedVus, Math.max(2, Math.ceil(rate * 0.5)));
    return { preAllocatedVUs, maxVUs: clamp(Math.ceil(rate * 4), preAllocatedVUs, kafkaMaxVus) };
  }
  if (kind === 'http') {
    const preAllocatedVUs = clamp(Math.ceil(rate * 0.5), 2, maxVus);
    const maxVUs = clamp(Math.max(Math.ceil(rate * 4), 50), 2, maxVus);
    // k6 refuses maxVUs below preAllocatedVUs.
    return { preAllocatedVUs, maxVUs: Math.max(maxVUs, preAllocatedVUs) };
  }
  throw new Error(`Unknown test kind "${kind}": use http or kafka`);
}

/**
 * k6 scenarios for every phase of the plan: smoke / warm-up / measure.
 * Why: scenario names are the phase names, so `{scenario:measure}` filters in thresholds and reports
 * always mean "the measured phase".
 * @param {import('./phase-plan.js').PhasePlan} phasePlan
 * @param {{exec?:string, kind?:'http'|'kafka', maxVus?:number, kafkaPreAllocatedVus?:number, kafkaMaxVus?:number}} [options]
 * @returns {Record<string, object>} k6 options.scenarios
 */
export function buildScenarios(
  phasePlan,
  { exec = 'default', kind = 'http', maxVus, kafkaPreAllocatedVus, kafkaMaxVus } = {},
) {
  if (phasePlan.breakpointKind === 'none') {
    throw new Error(
      'Step SLA (breakpointKind "none") is seeded, not driven by k6: it has no k6 scenarios',
    );
  }
  const limits = { kind, maxVus, kafkaPreAllocatedVus, kafkaMaxVus };
  const scenarios = {};
  for (const phase of phasePlan.phases) {
    const common = {
      timeUnit: '1s', // rates are per second
      startTime: toK6Duration(phase.startSeconds), // relative to the end of setup() (k6 clock contract)
      exec,
      // Scenario tags reach every metric, even dropped_iterations (which VU tags cannot reach).
      tags: { phase: phase.name },
    };
    if (phase.kind === 'staircase') {
      const first = vusFor(phase.levels[0].rate, limits);
      const top = vusFor(phase.levels[phase.levels.length - 1].rate, limits);
      scenarios[phase.name] = {
        executor: 'ramping-arrival-rate',
        startRate: phase.levels[0].rate,
        ...common,
        // Jump to each level in 1 s, then hold it for the rest of the level (v1 breakpoint.js).
        stages: phase.levels.flatMap((level) => [
          { duration: '1s', target: level.rate },
          { duration: toK6Duration(level.durationSeconds - 1), target: level.rate },
        ]),
        // Ready for the first level, allowed to grow up to what the top level needs.
        preAllocatedVUs: first.preAllocatedVUs,
        maxVUs: Math.max(top.maxVUs, first.preAllocatedVUs),
      };
    } else {
      scenarios[phase.name] = {
        executor: 'constant-arrival-rate',
        rate: phase.rate,
        duration: toK6Duration(k6ConstantSeconds(phase)),
        ...common,
        ...vusFor(phase.rate, limits),
      };
    }
  }
  return scenarios;
}

/**
 * The complete k6 options of a test, from its run context.
 * Why: every test file gets the same scenarios, rules, statistics and tags with one line.
 * @param {{context: object, kind: 'http'|'kafka'}} input context = parsed run-context.json (plan §3.5)
 * @returns {{scenarios:object, thresholds:object, summaryTrendStats:string[], tags:object, noConnectionReuse:boolean}}
 */
export function buildOptions({ context, kind }) {
  if (!context || !context.phasePlan || !context.settings) {
    throw new Error(
      'buildOptions needs the run context (settings + phasePlan): run tests through scripts/run-test.sh',
    );
  }
  const { settings, phasePlan } = context;
  const limits =
    kind === 'kafka'
      ? {
          kafkaPreAllocatedVus: requireInteger(settings, 'KAFKA_PRE_ALLOCATED_VUS', { min: 1 }),
          kafkaMaxVus: requireInteger(settings, 'KAFKA_MAX_VUS', { min: 1 }),
        }
      : { maxVus: requireInteger(settings, 'MAX_VUS', { min: 2 }) };
  return {
    scenarios: buildScenarios(phasePlan, { kind, ...limits }),
    thresholds: buildThresholds({ phasePlan, settings, kind }),
    summaryTrendStats: SUMMARY_TREND_STATS,
    // Same names as the Prometheus labels (plan §9.3), so Grafana can filter one run.
    tags: {
      testid: context.runId,
      service: context.subject,
      test_type: context.testType,
      plan_definition_set: context.planDefinitionSet ? context.planDefinitionSet.name : 'none',
      environment: context.environment ? context.environment.name : 'unknown',
    },
    // Keep HTTP connections open between requests, as real clients and the adaptor do.
    noConnectionReuse: false,
  };
}

/**
 * How long k6 runs a constant-rate phase so that it starts exactly phase.plannedEvents events.
 * Why: k6 starts an event at t = 0, 1/rate, 2/rate, … while t < duration. Whole-second phases keep
 * their own duration (e.g. 600 s at 50/s = 30,000). A fractional duration (an event total such as
 * LOAD_EVENTS=1001 at 50/s = 20.02 s) would put the end exactly on the next event start, so k6 is
 * stopped half a gap earlier instead: (plannedEvents − 0.5) / rate = 20.01 s → events 0 … 1000 start,
 * the 1,002nd (at 20.02 s) does not. Never below 1 s, k6's minimum (planned = rate at exactly 1 s).
 * @param {import('./phase-plan.js').Phase} phase a constant phase with rate > 0
 * @returns {number} seconds
 */
export function k6ConstantSeconds(phase) {
  if (Number.isInteger(phase.durationSeconds)) return phase.durationSeconds;
  return Math.max(1, (phase.plannedEvents - 0.5) / phase.rate);
}

/** Keeps a number inside [low, high] (high wins if it is below low); why: VU limits are bounds. */
function clamp(value, low, high) {
  return Math.min(Math.max(value, low), Math.max(low, high));
}
