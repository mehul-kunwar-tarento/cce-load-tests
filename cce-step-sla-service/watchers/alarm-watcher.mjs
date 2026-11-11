/**
 * alarm-watcher.mjs — follows Step SLA live while the seeded alarms ring, until it has handled them all.
 *
 * What:    Step SLA never refuses work: when it cannot keep up, alarms simply wait longer. So the test watches
 *          the service's own Prometheus metrics every WATCH_INTERVAL (plan §6.5, §6.7):
 *            due       cce_sla_transitions_due — alarms that have rung and are not handled yet (the backlog)
 *            handled   increase of cce_sla_transitions_applied_total + _skipped_total since the watch began
 *            cycles    cce_sla_evaluator_cycles_total — goes up every poll: proves the scheduler is alive
 *            failed    cce_sla_evaluator_batches_failed_total — batches rolled back and retried later
 *          It is done when every seeded alarm is handled ("caught up", with the seconds after the last ring)
 *          or when CATCH_UP_LIMIT (storm: BREAKPOINT_CATCH_UP_LIMIT) has passed after the last ring — then it
 *          says "not caught up", how many are still waiting and when it gave up, and NEVER a catch-up time
 *          (the v1 bug, D19). It stops the run early when a counter goes down (Step SLA restarted), when the
 *          scheduler stops (cycles and handled both flat), or when alarms wait and nothing moves for
 *          STALL_TIMEOUT. For the storm only, it reports the drain rate (median alarms handled per second
 *          while more than 1,000 are due, lesson 6) and how often a cycle hit the 10,000-rows cap
 *          (100 batches × 100 rows; an estimate from the counters, see slaCycleCapHits below).
 *          The counters are global (all of Step SLA's work), so the database checks stay the verdict.
 * How:     Created by the service module: watchers: [(ctx) => createAlarmWatcher(ctx, { plan })];
 *          the runner calls start(), then awaits whenDone() (tools/core/watchers.mjs).
 * Needs:   ctx.scrape('step-sla') (actuator/prometheus), ctx.times (seed times), ctx.settings, ctx.resultsDir,
 *          ctx.environment (services.stepSla.pollIntervalSeconds), ctx.abortLoad; plan from describe().
 * Outputs: <resultsDir>/watch-alarms.json (rewritten after every sample) and a WatcherOutcome
 *          { name, subject, file, samples, thresholds, breaking, load, peaks: { slaCycleCapHits }, aborted? }.
 */
import {
  createSampleLog,
  createStallDetector,
  isCounterReset,
  maxMetric,
  serviceConfig,
  sumMetric,
  toIsoWithOffset,
} from '../shared.mjs';

/** Rows one Step SLA cycle can handle at most: MAX_BATCHES_PER_CYCLE (100) × batch size (100, default). */
export const SLA_ROWS_PER_CYCLE_CAP = 10_000;

/** Above this many due alarms Step SLA is "flat out": handled/s then measures its drain rate (as v1). */
export const DRAIN_RATE_MIN_DUE = 1000;

/** Alarms that must be waiting before "nothing handled" can count as a stall (plan §6.5: backlog > 10). */
export const STALL_MIN_DUE = 10;

/** Default sleep; why: unit tests inject an instant one driven by a fake clock. */
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Median of numbers, or null; why: one slow sample must not decide the drain rate. */
export function median(values) {
  const sorted = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Reads Step SLA's counters from one scrape; a missing metric is null (never an exception).
 * Why: plan §6.5 — a scrape failure or a renamed metric must leave a gap in the data, not kill the run.
 * @param {Map|null} parsed parsed Prometheus text (tools/core/clients/prometheus-text.mjs)
 */
export function readAlarmCounters(parsed) {
  if (!parsed) {
    return {
      due: null,
      applied: null,
      skipped: null,
      cycles: null,
      batchesFailed: null,
      handledTotal: null,
    };
  }
  const applied = sumMetric(parsed, 'cce_sla_transitions_applied_total');
  const skipped = sumMetric(parsed, 'cce_sla_transitions_skipped_total');
  return {
    due: maxMetric(parsed, 'cce_sla_transitions_due'),
    applied,
    skipped,
    cycles: sumMetric(parsed, 'cce_sla_evaluator_cycles_total'),
    batchesFailed: sumMetric(parsed, 'cce_sla_evaluator_batches_failed_total'),
    // "Handled" = transitions that reached a verdict or were skipped; one seeded DUE alarm = one applied.
    handledTotal: applied === null && skipped === null ? null : (applied ?? 0) + (skipped ?? 0),
  };
}

/**
 * Counts cycles that hit the 10,000-rows cap, from the cycles counter and the handled counter.
 * Why: a cycle stops after 100 batches even with more alarms due; how often that happens explains a slow
 * storm drain ("Step SLA hit the 10,000-rows-per-cycle cap", plan §6.3 PEAK_SIGNALS). The cycles counter
 * goes up at the START of each cycle, so the rows handled between two increments belong to the cycle(s)
 * that began at the first one. Estimate: ± one sample interval of rows.
 * @param {number} [cap]
 * @returns {{update(sample:{at:string, cycles:number|null, handledTotal:number|null}):void, result():{value:number, firstAt:string|null}}}
 */
export function createCycleCapCounter(cap = SLA_ROWS_PER_CYCLE_CAP) {
  let lastCycles = null;
  let segmentStartHandled = null;
  let hits = 0;
  let firstAt = null;
  return {
    update({ at, cycles, handledTotal }) {
      if (typeof cycles !== 'number' || typeof handledTotal !== 'number') return;
      if (lastCycles === null || cycles < lastCycles) {
        // First reading, or a restart (the watcher aborts on that anyway): start a new segment.
        lastCycles = cycles;
        segmentStartHandled = handledTotal;
        return;
      }
      if (cycles === lastCycles) return; // the same cycle(s) still running: keep accumulating
      const rows = handledTotal - segmentStartHandled;
      const cyclesInSegment = cycles - lastCycles;
      const capped = Math.min(cyclesInSegment, Math.floor(rows / cap));
      if (capped > 0) {
        hits += capped;
        firstAt ??= at;
      }
      lastCycles = cycles;
      segmentStartHandled = handledTotal;
    },
    result() {
      return { value: hits, firstAt };
    },
  };
}

/**
 * Creates the alarm watcher of one run.
 * @param {object} ctx run ctx (plan §6.4)
 * @param {{plan:{alarmCount:number, ratePerSecond:number, catchUpLimitSeconds:number},
 *          sleep?:(ms:number)=>Promise<void>, now?:()=>number, write?:Function}} options
 * @returns {{name:string, start():Promise<void>, stop():Promise<void>, whenDone():Promise<object>}}
 */
export function createAlarmWatcher(ctx, { plan, sleep = realSleep, now = Date.now, write } = {}) {
  const settings = ctx.settings;
  const testType = ctx.phasePlan?.testType ?? ctx.context?.testType ?? null;
  const storm = testType === 'breakpoint';
  const intervalSeconds = settings.WATCH_INTERVAL;
  const pollSeconds = serviceConfig(ctx.environment, 'step-sla')?.pollIntervalSeconds ?? 5;
  // A capped cycle can run for seconds without the cycles counter moving, so "scheduler stopped" needs
  // BOTH counters flat for this long.
  const schedulerWindowSeconds = Math.max(settings.STALL_TIMEOUT, 3 * pollSeconds);
  const sampleLog = createSampleLog({
    name: 'alarms',
    resultsDir: ctx.resultsDir,
    intervalSeconds,
    ...(write ? { write } : {}),
  });
  const warnings = [];
  let stopped = false;
  let loop = null;

  /** One scrape, never throwing; why: a missed scrape is a gap, not a failure. */
  async function readNow() {
    try {
      return readAlarmCounters(await ctx.scrape('step-sla'));
    } catch (error) {
      const warning = `alarm watcher: could not scrape Step SLA (${error.message})`;
      if (!warnings.includes(warning)) warnings.push(warning);
      ctx.logger?.warn?.(warning);
      return readAlarmCounters(null);
    }
  }

  /** The watch loop; resolves with the WatcherOutcome. */
  async function run() {
    // Seeded runs: ready resolves as soon as prepare() returned the ring times.
    await ctx.times.ready;
    const ringStartMs = new Date(ctx.times.measureStart).getTime();
    const ringEndMs = new Date(ctx.times.sendEnd).getTime();
    const limitSeconds = plan.catchUpLimitSeconds;
    /** A fresh stall detector; why: see the reset before each stall check below. */
    const newStallDetector = () =>
      createStallDetector({ stallSeconds: settings.STALL_TIMEOUT, minBacklog: STALL_MIN_DUE });
    let stall = newStallDetector();
    const capCounter = createCycleCapCounter();
    const drainRates = [];
    let baseline = null; // first non-null handledTotal: counters are global, only the increase counts
    let previous = null; // previous sample with numbers, for rates and reset detection
    let lastMoveMs = now(); // last time cycles or handled went up (scheduler alive)
    let maxDue = null;
    let handled = 0;
    let finish; // set by exactly one of the exit paths below

    for (let first = true; ; first = false) {
      if (!first) await sleep(intervalSeconds * 1000);
      const atMs = now();
      const c = await readNow();
      if (stopped) {
        finish = {
          aborted: 'the runner stopped the watcher (Ctrl-C) before every alarm was handled',
        };
        break;
      }
      if (baseline === null && typeof c.handledTotal === 'number') baseline = c.handledTotal;
      if (typeof c.handledTotal === 'number') handled = c.handledTotal - baseline;
      const dtSeconds = previous ? (atMs - previous.atMs) / 1000 : null;
      const processedPerSecond =
        previous && dtSeconds > 0 && typeof c.handledTotal === 'number'
          ? (c.handledTotal - previous.handledTotal) / dtSeconds
          : null;
      const t = Math.round((atMs - ringStartMs) / 100) / 10; // seconds since the first alarm rang
      const phase = atMs < ringStartMs ? 'before-ring' : atMs <= ringEndMs ? 'ringing' : 'catch-up';
      const at = toIsoWithOffset(new Date(atMs));
      sampleLog.add({
        t,
        phase,
        due: c.due,
        applied: c.applied,
        skipped: c.skipped,
        cycles: c.cycles,
        batchesFailed: c.batchesFailed,
        handled,
        processedPerSecond,
      });
      if (typeof c.due === 'number') maxDue = Math.max(maxDue ?? 0, c.due);
      capCounter.update({ at, cycles: c.cycles, handledTotal: c.handledTotal });
      if (
        storm &&
        typeof c.due === 'number' &&
        c.due > DRAIN_RATE_MIN_DUE &&
        processedPerSecond !== null
      ) {
        drainRates.push(processedPerSecond);
      }

      // Restart: a counter went down, so every number after this point would be wrong.
      if (
        previous &&
        (isCounterReset(previous.handledTotal, c.handledTotal) ||
          isCounterReset(previous.cycles, c.cycles))
      ) {
        finish = { aborted: 'Step SLA counters went down: the service restarted during the test' };
        break;
      }
      // Scheduler alive: some counter moved recently (or we have no reading to judge).
      const moved =
        !previous ||
        (typeof c.cycles === 'number' && c.cycles > (previous.cycles ?? c.cycles)) ||
        (typeof c.handledTotal === 'number' &&
          c.handledTotal > (previous.handledTotal ?? c.handledTotal));
      if (moved || c.cycles === null) lastMoveMs = atMs;
      if (atMs - lastMoveMs >= schedulerWindowSeconds * 1000) {
        finish = {
          aborted: `Step SLA scheduler stopped: no evaluation cycle and nothing handled for ${schedulerWindowSeconds} s`,
        };
        break;
      }
      // Stall: alarms waiting (> 10) and nothing handled for STALL_TIMEOUT (plan §6.5). The shared detector
      // measures "no progress" from the last change of the handled counter, which also stands still while
      // nothing is due (the minute before the first ring): without this reset a storm would be called
      // "stalled" at its first sample. So the stall clock only runs while alarms are actually waiting.
      if (!(typeof c.due === 'number' && c.due > STALL_MIN_DUE)) stall = newStallDetector();
      if (stall.update({ atMs, backlog: c.due, progress: c.handledTotal })) {
        finish = {
          aborted: `stalled: Step SLA handled nothing for ${settings.STALL_TIMEOUT} s with ${c.due} alarms due`,
        };
        break;
      }
      if (typeof c.handledTotal === 'number')
        previous = { atMs, handledTotal: c.handledTotal, cycles: c.cycles };
      else if (!previous) previous = { atMs, handledTotal: null, cycles: c.cycles };

      // Done: every seeded alarm handled ...
      if (handled >= plan.alarmCount && atMs >= ringStartMs) {
        finish = { caughtUp: true, catchUpSeconds: Math.max(0, (atMs - ringEndMs) / 1000) };
        break;
      }
      // ... or the catch-up limit after the last ring has passed: give up, and say so.
      if (atMs >= ringEndMs + limitSeconds * 1000) {
        finish = {
          caughtUp: false,
          remainingBacklog: Math.max(0, plan.alarmCount - handled),
          gaveUpAfterSeconds: limitSeconds,
        };
        break;
      }
    }

    if (finish.aborted) ctx.abortLoad?.(finish.aborted);
    return buildOutcome({ finish, handled, maxDue, drainRates, capCounter, limitSeconds });
  }

  /** Turns the loop's findings into the WatcherOutcome (plan §6.5). */
  function buildOutcome({ finish, handled, maxDue, drainRates, capCounter, limitSeconds }) {
    const caughtUp = finish.caughtUp === true;
    const remaining = caughtUp
      ? 0
      : (finish.remainingBacklog ?? Math.max(0, plan.alarmCount - handled));
    const limitName = storm ? 'BREAKPOINT_CATCH_UP_LIMIT' : 'CATCH_UP_LIMIT';
    const thresholds = [
      {
        id: 'step-sla.caught-up',
        metric: 'alarmsNotHandled',
        rule: '= 0',
        limit: 0,
        actual: remaining,
        unit: 'alarms',
        passed: caughtUp,
        toBeConfirmed: false,
        source: 'watcher',
        description: `Every alarm handled within ${limitSeconds} s after the last one rang (${limitName}; Step SLA counters)`,
      },
      {
        id: 'step-sla.batches-failed',
        metric: 'batchesFailed',
        rule: '= 0',
        limit: 0,
        actual: batchesFailedDelta(),
        unit: 'batches',
        passed: (batchesFailedDelta() ?? 0) === 0,
        toBeConfirmed: false,
        source: 'watcher',
        description:
          'No Step SLA batch rolled back (cce_sla_evaluator_batches_failed_total did not grow)',
      },
      {
        id: 'step-sla.scheduler-alive',
        metric: 'evaluatorCycles',
        rule: '> 0',
        limit: 0,
        actual: cyclesDelta(),
        unit: 'cycles',
        // Unknown (metric absent) is not proof of a dead scheduler: the abort rule covers that case.
        passed: cyclesDelta() === null || cyclesDelta() > 0 || caughtUp,
        toBeConfirmed: false,
        source: 'watcher',
        description:
          'Step SLA ran evaluation cycles during the test (cce_sla_evaluator_cycles_total grew)',
      },
    ];
    const drainRate = storm ? median(drainRates) : null;
    if (storm) {
      const peak = settings.STEP_SLA_PEAK_ALARM_RATE;
      const target = typeof peak === 'number' ? settings.EXPECTED_HEADROOM * peak : null;
      thresholds.push({
        id: 'step-sla.drain-rate',
        metric: 'drainRate',
        rule: target === null ? 'median > 0' : `median >= ${target}`,
        limit: target ?? 0,
        actual: drainRate,
        unit: 'alarms/s',
        passed: drainRate !== null && drainRate >= (target ?? Number.MIN_VALUE),
        toBeConfirmed: true,
        informational: true,
        source: 'watcher',
        description:
          target === null
            ? 'Storm drain rate (median alarms/s while more than 1,000 were due)'
            : `Storm drain rate at least ${target} alarms/s (${settings.EXPECTED_HEADROOM} × peak ${peak} alarms/s)`,
      });
    }
    const breaking = caughtUp
      ? {
          caughtUp: true,
          catchUpSeconds: finish.catchUpSeconds,
          remainingBacklog: 0,
          gaveUpAfterSeconds: null,
        }
      : {
          caughtUp: false,
          catchUpSeconds: null, // never a number when not caught up (D19)
          remainingBacklog: remaining,
          gaveUpAfterSeconds: finish.gaveUpAfterSeconds ?? null,
        };
    // The drain rate is reported for the storm only: at a steady rate it just equals the ring rate (lesson 6).
    if (storm) breaking.drainRate = drainRate;
    const outcome = {
      name: 'alarms',
      subject: 'step-sla',
      file: 'watch-alarms.json',
      samples: sampleLog.samples,
      thresholds,
      breaking,
      load: { eventsProcessed: handled },
      peaks: { slaCycleCapHits: capCounter.result() },
      maxDue,
      warnings,
      ...(finish.aborted ? { aborted: finish.aborted } : {}),
    };
    sampleLog.finish({
      caughtUp: breaking.caughtUp,
      catchUpSeconds: breaking.catchUpSeconds,
      remainingBacklog: breaking.remainingBacklog,
      gaveUpAfterSeconds: breaking.gaveUpAfterSeconds,
      drainRate: storm ? drainRate : null,
      handled,
      maxDue,
      slaCycleCapHits: capCounter.result(),
      aborted: finish.aborted ?? null,
    });
    return outcome;

    /** Batches that failed during the watch (null when the metric never appeared). */
    function batchesFailedDelta() {
      const samples = sampleLog.samples.filter((s) => typeof s.batchesFailed === 'number');
      return samples.length
        ? samples[samples.length - 1].batchesFailed - samples[0].batchesFailed
        : null;
    }
    /** Cycles run during the watch (null when the metric never appeared). */
    function cyclesDelta() {
      const samples = sampleLog.samples.filter((s) => typeof s.cycles === 'number');
      return samples.length ? samples[samples.length - 1].cycles - samples[0].cycles : null;
    }
  }

  return {
    name: 'alarms',
    /** Starts the loop in the background; why: the runner awaits start() before the alarms ring. */
    async start() {
      loop = run();
      loop.catch(() => {}); // the error is reported through whenDone()
    },
    /** Asks the loop to finish at its next sample (Ctrl-C). */
    async stop() {
      stopped = true;
    },
    whenDone() {
      return loop ?? Promise.reject(new Error('alarm watcher was never started'));
    },
  };
}
