/**
 * service-module.mjs — plugs the Step SLA performance tests into the shared test runner (plan §6.4).
 *
 * What:    The runner (node tools/cli.mjs run <env> step-sla <type>) does the same steps for every service:
 *          preflight, wait until idle, prepare the load, watch, check the data, build result.json and the report.
 *          This object tells it what is special about Step SLA:
 *            - kind 'seeded': no k6. prepare() seeds alarms in Postgres with chosen ring times
 *              (seeding/seed-alarms.mjs) and returns them, so the "measured phase" = first ring → last ring;
 *            - breakpointKind 'none': the breakpoint test is the storm (all alarms ring at once);
 *            - watchers: the alarm watcher (watchers/alarm-watcher.mjs) follows Step SLA's counters;
 *            - dataChecks: each alarm's wait from the database (data-checks/step-sla-data-checks.mjs);
 *            - expectation: rates in ALARMS per second against STEP_SLA_PEAK_ALARM_RATE (never PEAK_RATE,
 *              which counts events: one event creates 1 to 3 DUE alarms depending on the plan-definition set);
 *            - prepare() first warns about per-run overrides Step SLA ignores (WARM_UP_RATE, WARM_UP_DURATION,
 *              DATASET, EVENT_ACTION_ID, EVENT_SOURCE, FACILITY_ID): there is no warm-up and no event is sent.
 *              The warning is printed and saved in result.json "warnings", so nobody reads a warm-up into it.
 * How:     Found automatically by tools/core/service-registry.mjs; run with
 *          scripts/run-test.sh local step-sla smoke|load|stress|breakpoint  [--set NAME=value]
 * Needs:   shared.mjs (the only door to the shared tooling); a running Step SLA (port 8099 on local-stack),
 *          Postgres (DB_PASSWORD) and the plan-definition set loaded (ACTIVE).
 * Outputs: The default-exported service module object.
 */
import { createAlarmWatcher } from './watchers/alarm-watcher.mjs';
import { runStepSlaDataChecks } from './data-checks/step-sla-data-checks.mjs';
import { seedAlarms } from './seeding/seed-alarms.mjs';
import {
  buildPhasePlan,
  formatNumber,
  formatSeconds,
  readJsonIfExists,
  waitForStepSlaIdle,
} from './shared.mjs';
import breakpointTest from './tests/step-sla-breakpoint.test.mjs';
import loadTest from './tests/step-sla-load.test.mjs';
import smokeTest from './tests/step-sla-smoke.test.mjs';
import stressTest from './tests/step-sla-stress.test.mjs';
import path from 'node:path';

/** The test definitions by type (each file is also what testFile() points at). */
export const TEST_DEFINITIONS = Object.freeze({
  smoke: smokeTest,
  load: loadTest,
  stress: stressTest,
  breakpoint: breakpointTest,
});

/** Settings prefix of the steady-rate test types (plan §3.2). */
const PREFIX = { smoke: 'SMOKE', load: 'LOAD', stress: 'STRESS' };

/**
 * The test type of a run ctx (run or check-data).
 * Why: both ctx shapes carry the phase plan and the run context; either names the type.
 */
function testTypeOf(ctx) {
  return ctx.phasePlan?.testType ?? ctx.context?.testType ?? null;
}

/**
 * describe() of the run's test definition: alarm count, ring rate, wait and catch-up limits.
 * Why: seeding, watcher, data checks and evaluate must all use the same numbers. Works with the run ctx
 * (which has `resolved`) and the check-data ctx (values + phase plan only).
 * @param {object} ctx
 * @returns {{alarmCount:number, ratePerSecond:number, maxWaitSeconds:number, catchUpLimitSeconds:number}}
 */
export function describeRun(ctx) {
  const definition = TEST_DEFINITIONS[testTypeOf(ctx)];
  if (!definition) throw new Error(`Step SLA has no test definition for "${testTypeOf(ctx)}"`);
  const resolved = ctx.resolved ?? { values: ctx.settings, derived: { phasePlan: ctx.phasePlan } };
  return definition.describe(resolved);
}

/**
 * Settings the shared settings file offers to every service but Step SLA does not use, with the reason.
 * Why: WARM_UP_* apply to "load, stress, breakpoint" of every service in config/settings/defaults.json, so the
 * runner accepts and prints them for Step SLA too; the event settings only matter for k6 services.
 */
export const SETTINGS_NOT_USED = Object.freeze({
  WARM_UP_RATE:
    'Step SLA has no warm-up phase (the seeded alarms ring on their schedule from the first one)',
  WARM_UP_DURATION:
    'Step SLA has no warm-up phase (the seeded alarms ring on their schedule from the first one)',
  DATASET: 'Step SLA sends no events: it seeds alarms in Postgres',
  EVENT_ACTION_ID: 'Step SLA sends no events: the seeded step is chosen by STEP_SLA_ACTION_ID',
  EVENT_SOURCE: 'Step SLA sends no events',
  FACILITY_ID: 'Step SLA sends no events',
});

/** Sources of a value the tester set for THIS run (an environment file's value is meant for other services). */
const PER_RUN_SOURCES = ['cli', 'env-var'];

/**
 * Warnings for settings the tester overrode for this run although Step SLA ignores them (see SETTINGS_NOT_USED).
 * Why: an override that silently does nothing (e.g. --set WARM_UP_DURATION=5m) would make the saved conditions
 * suggest a warm-up that never happened. Pure: reads resolved.values/sources only.
 * @param {{values?:Record<string, unknown>, sources?:Record<string, string>}} resolved
 * @returns {string[]}
 */
export function unusedSettingWarnings(resolved) {
  const warnings = [];
  for (const [name, reason] of Object.entries(SETTINGS_NOT_USED)) {
    const source = resolved?.sources?.[name];
    if (!PER_RUN_SOURCES.includes(source)) continue;
    const value = resolved.values?.[name];
    const shown = name === 'WARM_UP_DURATION' ? formatSeconds(value) : String(value);
    warnings.push(`${name}=${shown} (${source}) is ignored: ${reason}`);
  }
  return warnings;
}

/** Rounds to 2 decimals or returns null; why: "0.33 × peak" reads better than 0.3333333. */
function round2(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

/** A data check by id, or undefined. */
function checkById(checks, id) {
  return (checks ?? []).find((check) => check.id === id);
}

export default {
  service: 'cce-step-sla-service',
  subject: 'step-sla',
  idCode: 'sla',
  displayName: 'Step SLA',
  kind: 'seeded',
  breakpointKind: 'none',
  testTypes: ['smoke', 'load', 'stress', 'breakpoint'],
  // Preflight (plan §7.1): Step SLA health + metrics + scheduler, Postgres incl. step_group_instance, and the
  // protocol service (the set's plan definitions must be ACTIVE: seeded enrolments reference them). No Kafka.
  requires: { services: ['step-sla'], postgres: true, kafka: false, protocol: true },

  /** The Node test definition of a test type; why: module-relative, so the folder works wherever it is copied. */
  testFile(testType) {
    return new URL(`./tests/step-sla-${testType}.test.mjs`, import.meta.url);
  },

  /**
   * What the service should withstand, in alarms/s (R1.3), marked "to be confirmed" (TBC).
   * Why: the report prints it next to the result; "× peak" must compare alarms with alarms.
   */
  expectation({ testType, settings }) {
    const peak =
      typeof settings.STEP_SLA_PEAK_ALARM_RATE === 'number'
        ? settings.STEP_SLA_PEAK_ALARM_RATE
        : null;
    const peakText =
      peak === null ? 'peak alarm rate unknown' : `peak ${formatNumber(peak)} alarms/s`;
    // Same code as the settings resolver, so the count printed here is the count seeded.
    const phasePlan = buildPhasePlan({ testType, settings, breakpointKind: 'none' });
    const alarms = phasePlan.plannedMeasuredEvents;
    if (testType === 'breakpoint') {
      const target = peak === null ? null : settings.EXPECTED_HEADROOM * peak;
      const drain =
        target === null
          ? 'drain rate reported'
          : `drain ≥ ${formatNumber(target)} alarms/s = ${formatNumber(settings.EXPECTED_HEADROOM)} × ${peakText}`;
      return {
        summary:
          `Handle a storm of ${formatNumber(alarms)} alarms ringing at once within ` +
          `${formatSeconds(settings.STEP_SLA_STORM_MAX_CATCH_UP)} (${drain}).`,
        targetRate: target,
        peakRate: peak,
        multipleOfPeak: target === null ? null : settings.EXPECTED_HEADROOM,
        unit: 'alarms',
        toBeConfirmed: true,
      };
    }
    const rate = settings[`${PREFIX[testType]}_RATE`];
    const duration = settings[`${PREFIX[testType]}_DURATION`];
    const multiple = peak === null ? null : round2(rate / peak);
    return {
      summary:
        `Handle ${formatNumber(alarms)} alarms ringing ${formatNumber(rate)}/s for ${formatSeconds(duration)} ` +
        `(${multiple === null ? peakText : `${formatNumber(multiple)} × ${peakText}`}): every alarm handled, ` +
        `each within ${formatSeconds(settings.STEP_SLA_MAX_WAIT)} of ringing (STEP_SLA_MAX_WAIT), ` +
        'each step OVERDUE with one deviation.',
      targetRate: rate,
      peakRate: peak,
      multipleOfPeak: multiple,
      unit: 'alarms',
      toBeConfirmed: true,
    };
  },

  /** Before seeding: no due alarms for IDLE_FLAT_DURATION (a previous test's alarms would compete). */
  waitForIdle: (ctx) => waitForStepSlaIdle(ctx),

  /**
   * Warns about ignored overrides, then seeds the alarms; returns their ring times (PrepareResult, plan §6.4).
   * Why the warning here: prepare is the first Step SLA hook of a real run; ctx.logger's warnings go into
   * result.json "warnings" (the dry run has no module hook: see docs/test-plan.md "Settings Step SLA ignores").
   */
  prepare: (ctx) => {
    for (const warning of unusedSettingWarnings(ctx.resolved)) ctx.logger?.warn?.(warning);
    return seedAlarms(ctx, describeRun(ctx));
  },

  watchers: [(ctx) => createAlarmWatcher(ctx, { plan: describeRun(ctx) })],

  // Sampled with the common JVM/Hikari metrics into service-metrics.json (Grafana shows the same series).
  // 'slaBatchesFailed' is the key the slaBatchesFailed peak reads (tools/core/sampled-metrics.mjs).
  sampledMetrics: [
    { key: 'slaDue', name: 'cce_sla_transitions_due', agg: 'max', unit: 'alarms' },
    {
      key: 'slaApplied',
      name: 'cce_sla_transitions_applied_total',
      agg: 'sum',
      unit: 'transitions',
    },
    {
      key: 'slaSkipped',
      name: 'cce_sla_transitions_skipped_total',
      agg: 'sum',
      unit: 'transitions',
    },
    { key: 'slaCycles', name: 'cce_sla_evaluator_cycles_total', agg: 'sum', unit: 'cycles' },
    {
      key: 'slaBatchesFailed',
      name: 'cce_sla_evaluator_batches_failed_total',
      agg: 'sum',
      unit: 'batches',
    },
  ],

  /** The authoritative checks, from the database. */
  dataChecks: (ctx) => runStepSlaDataChecks(ctx, { plan: describeRun(ctx) }),

  /**
   * Step SLA-specific parts of the result: alarms as the load unit, catch-up and "started breaking" from the
   * database (the watcher's counters are global), notes from the seed manifest.
   * @param {object} ctx
   * @param {{watcherOutcomes?:object[], dataChecks?:object[]}} partial
   */
  evaluate(ctx, partial = {}) {
    const plan = describeRun(ctx);
    const storm = testTypeOf(ctx) === 'breakpoint';
    const checks = partial.dataChecks ?? [];
    const watcher = (partial.watcherOutcomes ?? []).find((o) => o.name === 'alarms') ?? null;
    const notes = [];
    const thresholds = [];
    const breaking = {};

    // Load: alarms seeded (from the database when the checks ran) and handled.
    const seeded = checkById(checks, 'step-sla.alarms-seeded')?.actual ?? plan.alarmCount;
    const handled = checkById(checks, 'step-sla.all-handled')?.actual;
    const load = {
      unit: 'alarms',
      eventsSent: seeded,
      eventsAccepted: seeded,
      eventsFailed: 0,
      measuredEventsSent: seeded,
      measuredEventsAccepted: seeded,
      // The ring rate; a storm has none (all at once): its speed is the drain rate.
      averageRate: storm ? null : plan.ratePerSecond,
      ...(typeof handled === 'number' ? { eventsProcessed: handled } : {}),
    };

    const verdict = checkById(checks, storm ? 'step-sla.storm-catch-up' : 'step-sla.max-wait');
    const details = verdict?.details ?? null;
    if (details) {
      if (details.startedBreakingAt) breaking.startedBreakingAt = details.startedBreakingAt;
      // A storm rings "all at once" (rate 0): there is no rate at which it broke.
      breaking.rateAtBreak = storm ? null : plan.ratePerSecond;
      const allHandled = details.handled === plan.alarmCount && plan.alarmCount > 0;
      const catchUp =
        allHandled && details.lastHandled && details.lastRing
          ? Math.max(
              0,
              Math.round((Date.parse(details.lastHandled) - Date.parse(details.lastRing)) / 100) /
                10,
            )
          : null;
      let caughtUp;
      if (allHandled && catchUp !== null && catchUp <= plan.catchUpLimitSeconds) {
        caughtUp = true;
        Object.assign(breaking, {
          caughtUp: true,
          catchUpSeconds: catchUp,
          remainingBacklog: 0,
          gaveUpAfterSeconds: null,
        });
      } else {
        caughtUp = false;
        Object.assign(breaking, {
          caughtUp: false,
          catchUpSeconds: null, // never a number when not caught up (D19)
          remainingBacklog: allHandled
            ? (watcher?.breaking?.remainingBacklog ?? null)
            : plan.alarmCount - (details.handled ?? 0),
          gaveUpAfterSeconds: watcher?.breaking?.gaveUpAfterSeconds ?? plan.catchUpLimitSeconds,
        });
        if (allHandled && catchUp !== null) {
          notes.push(
            `All ${formatNumber(plan.alarmCount)} alarms were handled eventually, ${formatSeconds(catchUp)} after ` +
              `the last one rang — later than the ${formatSeconds(plan.catchUpLimitSeconds)} catch-up limit.`,
          );
        }
      }
      // Same id as the watcher's rule: the database answer replaces the counter-based one.
      thresholds.push({
        id: 'step-sla.caught-up',
        metric: 'alarmsNotHandled',
        rule: '= 0',
        limit: 0,
        actual: caughtUp ? 0 : plan.alarmCount - (details.handled ?? 0),
        unit: 'alarms',
        passed: caughtUp,
        toBeConfirmed: false,
        source: 'data-check',
        description:
          `Every alarm handled within ${formatSeconds(plan.catchUpLimitSeconds)} after the last one rang ` +
          '(from the database)',
      });
      if (
        watcher &&
        typeof watcher.load?.eventsProcessed === 'number' &&
        watcher.load.eventsProcessed !== details.handled
      ) {
        notes.push(
          `Step SLA's counters moved by ${formatNumber(watcher.load.eventsProcessed)} transitions, the database ` +
            `shows ${formatNumber(details.handled)} of this run's alarms handled: the counters are global ` +
            '(other work ran at the same time, or alarms were handled before the watcher started).',
        );
      }
      if (storm) {
        const drain = checkById(checks, 'step-sla.storm-drain')?.actual;
        if (typeof drain === 'number') {
          notes.push(
            `Storm average (database): ${formatNumber(drain)} alarms/s from the ring to the last alarm handled.`,
          );
        }
      }
    }

    // The seed manifest: how the alarms were spread (the plan-definition set as a parameter, R2).
    const seed = ctx.resultsDir ? readJsonIfExists(path.join(ctx.resultsDir, 'seed.json')) : null;
    if (seed) {
      notes.push(
        `Seed mode ${seed.seedMode}: ${formatNumber(seed.alarmCount)} alarms over ${seed.pairs?.length ?? 0} ` +
          `(plan definition × mandatory step) pair(s) of set ${seed.planDefinitionSet ?? 'unknown'}` +
          `${seed.missedSeeded ? '; MISSED alarms also seeded (they ring 3 days later: clean up before then)' : ''}.`,
      );
      for (const warning of seed.warnings ?? []) notes.push(`Seeding: ${warning}`);
    }
    return { thresholds, breaking, load, notes };
  },

  /**
   * Numbers worth tracking over time (plan §8.3).
   * Why: baselines compare these between runs; a catch-up time exists only when it caught up.
   * @param {object} result result.json
   */
  baselineMetrics(result) {
    const type = result.testType;
    const actual = (id) => checkById(result.dataChecks, id)?.actual ?? null;
    if (type === 'load' || type === 'stress') {
      return [
        {
          key: `step-sla.${type}.maxWaitSeconds`,
          label: `Step SLA ${type}: longest wait after ringing`,
          unit: 's',
          better: 'lower',
          value: actual('step-sla.max-wait'),
        },
        {
          key: `step-sla.${type}.p95WaitSeconds`,
          label: `Step SLA ${type}: p95 wait after ringing`,
          unit: 's',
          better: 'lower',
          value: actual('step-sla.wait-p95'),
        },
      ];
    }
    if (type === 'breakpoint') {
      return [
        {
          key: 'step-sla.breakpoint.drainRate',
          label: 'Step SLA storm: drain rate',
          unit: 'alarms/s',
          better: 'higher',
          value: result.breaking?.drainRate ?? null,
        },
        {
          key: 'step-sla.breakpoint.catchUpSeconds',
          label: 'Step SLA storm: catch-up time',
          unit: 's',
          better: 'lower',
          value: result.breaking?.caughtUp === true ? result.breaking.catchUpSeconds : null,
        },
      ];
    }
    return []; // smoke proves the setup; it is not a measurement to track
  },
};
