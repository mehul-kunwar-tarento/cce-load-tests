/**
 * phase-plan.js — turns a test type and its settings into the schedule of phases (PURE)
 *
 * What:    A test is a sequence of phases: an optional warm-up (to let the Java services "warm up"
 *          before we measure), then the measured phase (constant rate, a staircase of rising rates,
 *          a flood, or a Step SLA ring schedule). This module computes, for every phase, its rate,
 *          start second, length and how many events it should send, plus the report windows.
 *          Node (settings printout, result builder) and k6 (scenarios, tags) use this SAME code, so
 *          both always agree on the schedule.
 * How:     import { buildPhasePlan, phaseAt, plannedSentBy } from '../lib/phase-plan.js';
 *          const plan = buildPhasePlan({ testType: 'load', settings, breakpointKind: 'staircase' });
 * Needs:   settings = ResolvedSettings.values (plan §3.3): durations in seconds, LEVELS as number[].
 *          *_EVENTS are NOT read here: tools/core/settings.mjs already turned them into *_DURATION.
 *          Durations may be fractional (an event total gives events / rate seconds, e.g. 1,001 events
 *          at 50/s = 20.02 s): planned events are then exactly that total, and lib/scenarios.js stops
 *          the k6 scenario between the last wanted event and the next one. Phases k6 runs must last
 *          at least 1 s (k6 refuses shorter arrival-rate scenarios); that is checked here.
 * Outputs: A PhasePlan object (plan §4.1), see the typedefs below.
 */

import { requireNumber, requireRate, requireRateList, requireInteger } from './settings-guard.js';

/**
 * @typedef {{rate:number, startSeconds:number, durationSeconds:number, plannedEvents:number}} Level
 *   One step of a staircase. startSeconds is counted from the k6 start (end of setup()).
 * @typedef {{name:'smoke'|'warm-up'|'measure', kind:'constant'|'staircase', rate:number,
 *            startSeconds:number, durationSeconds:number, plannedEvents:number, levels?: Level[]}} Phase
 *   rate: events/s (staircase: the top level; Step SLA storm: 0 = all at once).
 * @typedef {{testType:string, breakpointKind:'staircase'|'flood'|'none', phases:Phase[],
 *            measuredPhase:'smoke'|'measure', totalSeconds:number, plannedEvents:number,
 *            plannedMeasuredEvents:number, windowSeconds:number, windowCount:number}} PhasePlan
 */

/** The test types every service knows (plan §2.1); service-specific names map onto these. */
export const TEST_TYPES = ['smoke', 'load', 'stress', 'breakpoint'];

/** How a service's breakpoint test works: HTTP staircase, Kafka flood, or none (Step SLA, seeded). */
export const BREAKPOINT_KINDS = ['staircase', 'flood', 'none'];

/** Most windows a report may have, so per-window k6 sub-metrics stay a manageable number. */
const MAX_WINDOWS = 200;

/** Shortest phase k6 accepts for an arrival-rate scenario ("the duration must be at least 1s"). */
const K6_MIN_PHASE_SECONDS = 1;

/**
 * Durations are precise to the microsecond (lib/duration.js rounds to 1e-6 s), so rate × duration
 * within half a microsecond of the schedule of a whole number IS that number (e.g. 1001 / 3 s at 3/s).
 */
const DURATION_PRECISION_SECONDS = 5e-7;

/** Settings prefix per test type, e.g. load → LOAD_RATE / LOAD_DURATION. */
const PREFIX = { smoke: 'SMOKE', load: 'LOAD', stress: 'STRESS' };

/**
 * Builds the phase plan of one test.
 * Why: one function decides the schedule, so the printed plan, the k6 scenarios, the thresholds and
 * the report can never disagree.
 * @param {{testType:string, settings:Record<string, unknown>, breakpointKind?:string}} input
 * @returns {PhasePlan}
 */
export function buildPhasePlan({ testType, settings, breakpointKind = 'staircase' }) {
  if (!TEST_TYPES.includes(testType)) {
    throw new Error(`Unknown test type "${testType}": use one of ${TEST_TYPES.join(', ')}`);
  }
  if (!BREAKPOINT_KINDS.includes(breakpointKind)) {
    throw new Error(
      `Unknown breakpoint kind "${breakpointKind}": use one of ${BREAKPOINT_KINDS.join(', ')}`,
    );
  }
  if (!settings || typeof settings !== 'object') throw new Error('buildPhasePlan needs settings');

  // Step SLA (kind "none") has no k6: its "phase" is the ring schedule of the seeded alarms.
  const phases =
    breakpointKind === 'none'
      ? [seededPhase(testType, settings)]
      : loadGeneratorPhases(testType, settings, breakpointKind);

  const measured = phases[phases.length - 1];
  const totalSeconds = measured.startSeconds + measured.durationSeconds;
  const { windowSeconds, windowCount } = reportWindows(
    measured,
    testType,
    breakpointKind,
    settings,
  );

  return {
    testType,
    breakpointKind,
    phases,
    measuredPhase: measured.name,
    totalSeconds,
    plannedEvents: phases.reduce((sum, phase) => sum + phase.plannedEvents, 0),
    plannedMeasuredEvents: measured.plannedEvents,
    windowSeconds,
    windowCount,
  };
}

/**
 * Finds the phase (and staircase level) running at a moment of the test.
 * Why: Node needs it to label watcher samples, k6 to tag iterations.
 * @param {PhasePlan} phasePlan
 * @param {number} elapsedSeconds seconds since the k6 start (end of setup())
 * @returns {{phase: Phase|null, phaseIndex: number, level: Level|null}} phaseIndex -1 when no phase runs
 */
export function phaseAt(phasePlan, elapsedSeconds) {
  const phaseIndex = phasePlan.phases.findIndex(
    // Half-open [start, end): at the exact boundary the next phase has started.
    (phase) =>
      elapsedSeconds >= phase.startSeconds &&
      elapsedSeconds < phase.startSeconds + phase.durationSeconds,
  );
  if (phaseIndex < 0) return { phase: null, phaseIndex: -1, level: null };
  const phase = phasePlan.phases[phaseIndex];
  const level =
    phase.kind === 'staircase'
      ? (phase.levels.find(
          (l) =>
            elapsedSeconds >= l.startSeconds && elapsedSeconds < l.startSeconds + l.durationSeconds,
        ) ?? null)
      : null;
  return { phase, phaseIndex, level };
}

/**
 * Events the schedule should have started by a moment of the test (all phases together).
 * Why: an open load model sends at a known rate, so "how many should be sent by now" is arithmetic;
 * watchers compare it with what the service processed. The 1-second ramp between staircase levels is
 * ignored (it changes the count by at most half a second of the step).
 * @param {PhasePlan} phasePlan
 * @param {number} elapsedSeconds seconds since the k6 start
 * @returns {number} may be fractional
 */
export function plannedSentBy(phasePlan, elapsedSeconds) {
  let sent = 0;
  for (const phase of phasePlan.phases) {
    // Step SLA storm: every alarm rings at the same moment.
    if (phase.durationSeconds === 0) {
      if (elapsedSeconds >= phase.startSeconds) sent += phase.plannedEvents;
      continue;
    }
    const parts = phase.kind === 'staircase' ? phase.levels : [phase];
    for (const part of parts) {
      const running = clamp(elapsedSeconds - part.startSeconds, 0, part.durationSeconds);
      sent += Math.min(part.rate * running, part.plannedEvents);
    }
  }
  return sent;
}

/**
 * Returns the measured phase of a plan (the one the verdict is about).
 * Why: callers should not have to know whether it is called "smoke" or "measure".
 * @param {PhasePlan} phasePlan
 * @returns {Phase}
 */
export function measuredPhaseOf(phasePlan) {
  return phasePlan.phases.find((phase) => phase.name === phasePlan.measuredPhase);
}

// --- helpers ----------------------------------------------------------------------------------

/**
 * Phases of a k6 test (collector, matcher): optional warm-up, then the measured phase.
 * Why: the smoke test is short and never warmed up; the others warm the JVM first (D11).
 */
function loadGeneratorPhases(testType, settings, breakpointKind) {
  if (testType === 'smoke') {
    return [
      constantPhase(
        'smoke',
        requireRate(settings, 'SMOKE_RATE'),
        0,
        k6PhaseDuration(settings, 'SMOKE_DURATION'),
      ),
    ];
  }
  const phases = [];
  const warmUpSeconds = requireNumber(settings, 'WARM_UP_DURATION', { min: 0 });
  // WARM_UP_DURATION=0s switches warm-up off: no phase, no scenario, no warm-up abort rule.
  if (warmUpSeconds > 0) {
    k6PhaseDuration(settings, 'WARM_UP_DURATION'); // a warm-up that is on must still last 1 s or more
    phases.push(constantPhase('warm-up', requireRate(settings, 'WARM_UP_RATE'), 0, warmUpSeconds));
  }
  const start = warmUpSeconds;
  if (testType === 'breakpoint' && breakpointKind === 'staircase') {
    phases.push(staircasePhase(start, settings));
  } else if (testType === 'breakpoint') {
    // Flood (matcher): far more than the service can do, for a short time; then watch it drain.
    phases.push(
      constantPhase(
        'measure',
        requireRate(settings, 'MATCHER_FLOOD_RATE'),
        start,
        k6PhaseDuration(settings, 'MATCHER_FLOOD_DURATION'),
      ),
    );
  } else {
    const prefix = PREFIX[testType];
    phases.push(
      constantPhase(
        'measure',
        requireRate(settings, `${prefix}_RATE`),
        start,
        k6PhaseDuration(settings, `${prefix}_DURATION`),
      ),
    );
  }
  return phases;
}

/**
 * The single phase of a Step SLA test: when the seeded alarms ring (plan §4.1, §6.7).
 * Why: Step SLA is fed by alarms written into Postgres, not by k6; the phase plan still describes the
 * schedule, so the alarm count and ring rate have one source.
 */
function seededPhase(testType, settings) {
  // Alarms start ringing this long after seeding.
  const start = requireNumber(settings, 'STEP_SLA_FIRST_RING_DELAY', { min: 0 });
  if (testType === 'breakpoint') {
    // Storm: every alarm rings at the same moment (rate 0 = "all at once", no duration).
    const alarms = requireInteger(settings, 'STEP_SLA_STORM_ALARMS', { min: 1 });
    return {
      name: 'measure',
      kind: 'constant',
      rate: 0,
      startSeconds: start,
      durationSeconds: 0,
      plannedEvents: alarms,
    };
  }
  const prefix = PREFIX[testType];
  return constantPhase(
    'measure',
    requireRate(settings, `${prefix}_RATE`),
    start,
    positiveDuration(settings, `${prefix}_DURATION`),
  );
}

/**
 * The staircase: each LEVELS rate held for LEVEL_DURATION (HTTP breakpoint, ported from v1).
 * Why: climbing in steps shows the highest rate the service still handles ("held up to X/s").
 */
function staircasePhase(start, settings) {
  const rates = requireRateList(settings, 'LEVELS');
  const levelSeconds = requireNumber(settings, 'LEVEL_DURATION');
  // k6 jumps to each level in 1 s and holds it for the rest, so a level needs at least 2 s.
  if (levelSeconds < 2)
    throw new Error(`Setting LEVEL_DURATION must be at least 2s, got ${levelSeconds}s`);
  const levels = rates.map((rate, i) => ({
    rate,
    startSeconds: start + i * levelSeconds,
    durationSeconds: levelSeconds,
    plannedEvents: plannedFor(rate, levelSeconds),
  }));
  return {
    name: 'measure',
    kind: 'staircase',
    rate: rates[rates.length - 1],
    startSeconds: start,
    durationSeconds: levelSeconds * rates.length,
    plannedEvents: levels.reduce((sum, level) => sum + level.plannedEvents, 0),
    levels,
  };
}

/** A constant-rate phase; why: the common building block of smoke, warm-up, load, stress and flood. */
function constantPhase(name, rate, startSeconds, durationSeconds) {
  return {
    name,
    kind: 'constant',
    rate,
    startSeconds,
    durationSeconds,
    plannedEvents: plannedFor(rate, durationSeconds),
  };
}

/**
 * Report windows of the measured phase (plan §4.1): windowSeconds = max(REPORT_WINDOW, ceil(D / 200)).
 * Why: "when did it start breaking" is answered per window; at most 200 windows keeps k6's per-window
 * sub-metrics affordable. The storm phase has no duration, so its windows cover the catch-up limit.
 */
function reportWindows(measured, testType, breakpointKind, settings) {
  const reportWindow = requireNumber(settings, 'REPORT_WINDOW');
  if (reportWindow <= 0) throw new Error('Setting REPORT_WINDOW must be more than 0s');
  const stormLike = breakpointKind === 'none' && testType === 'breakpoint';
  const cover = stormLike
    ? requireNumber(settings, 'BREAKPOINT_CATCH_UP_LIMIT', { min: 0 })
    : measured.durationSeconds;
  const windowSeconds = Math.max(reportWindow, Math.ceil(cover / MAX_WINDOWS));
  // Small epsilon: 600 / 10 must be exactly 60 windows, not 61 because of float noise.
  const windowCount = Math.ceil(cover / windowSeconds - 1e-9);
  return { windowSeconds, windowCount };
}

/** Reads a duration that must be longer than 0 s; why: a 0-second measured phase measures nothing. */
function positiveDuration(settings, name) {
  const seconds = requireNumber(settings, name, { min: 0 });
  if (seconds <= 0) throw new Error(`Setting ${name} must be longer than 0s`);
  return seconds;
}

/**
 * Reads the duration of a phase k6 runs: longer than 0 s and at least 1 s (k6's minimum).
 * Why: k6 would otherwise stop at start-up with "the duration must be at least 1s"; refusing here
 * names the setting. An event total that is smaller than its rate (e.g. MATCHER_FLOOD_EVENTS=1001 at
 * 2,000/s = 0.5 s) ends up here too: it cannot be sent at that rate, so lower the rate or ask for more.
 */
function k6PhaseDuration(settings, name) {
  const seconds = positiveDuration(settings, name);
  if (seconds < K6_MIN_PHASE_SECONDS - DURATION_PRECISION_SECONDS) {
    throw new Error(
      `Setting ${name} must be at least ${K6_MIN_PHASE_SECONDS}s (k6 minimum), got ${seconds}s: ` +
        'with an event total (*_EVENTS) ask for at least as many events as the rate, or lower the rate',
    );
  }
  return seconds;
}

/**
 * Events a constant-arrival-rate scenario starts in a phase: k6 starts one at t=0, then every 1/rate s
 * while t < duration, i.e. ceil(rate × duration). Why: matches what k6 really sends (and is exactly
 * rate × duration for whole numbers, and exactly the event total when the duration came from
 * *_EVENTS = events / rate). The small tolerance absorbs microsecond rounding of durations.
 */
function plannedFor(rate, durationSeconds) {
  return Math.ceil(rate * durationSeconds - 1e-9 - rate * DURATION_PRECISION_SECONDS);
}

/** Keeps a number inside [low, high]; why: elapsed time before/after a phase counts as 0/all of it. */
function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}
