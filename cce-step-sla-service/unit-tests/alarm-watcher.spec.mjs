/**
 * alarm-watcher.spec.mjs — unit tests of the Step SLA alarm watcher (watchers/alarm-watcher.mjs).
 *
 * What:    Drives the watcher with a fake clock and fake Step SLA metric pages (no service, no network, D14)
 *          through every way a watch can end:
 *            caught up        every alarm handled → caughtUp true and the seconds after the last ring
 *            not caught up    limit after the last ring passed → caughtUp false, catchUpSeconds null (never the
 *                             give-up time, the v1 bug D19), remaining alarms, give-up time
 *            aborted          a counter went down (restart), the scheduler stopped, or a stall
 *          and the storm extras: drain rate (median alarms/s while > 1,000 due, breakpoint only) and
 *          slaCycleCapHits (cycles that handled >= 10,000 rows). Also: watch-alarms.json is written, a failed
 *          scrape is a warning and a gap (never an exception).
 * How:     npm test   (or: node --test cce-step-sla-service/unit-tests/alarm-watcher.spec.mjs)
 * Needs:   config/ and test-data/ of the repository (settings resolution, files only).
 * Outputs: node:test results; temporary results folders.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { describeRun } from '../service-module.mjs';
import { toIsoWithOffset } from '../shared.mjs';
import {
  createAlarmWatcher,
  createCycleCapCounter,
  median,
  readAlarmCounters,
  SLA_ROWS_PER_CYCLE_CAP,
} from '../watchers/alarm-watcher.mjs';
import { buildCtx, fakeClock, fakeScrape } from './helpers.mjs';

/** The moment the watcher starts (fake clock); the first alarm rings 60 s later (STEP_SLA_FIRST_RING_DELAY). */
const T0 = Date.parse('2026-11-05T14:24:00+05:30');
const RING_START = T0 + 60_000;

/** Counters of other work Step SLA did before the test: the watcher must count only the increase. */
const EARLIER_APPLIED = 1000;

/**
 * Builds a run ctx whose seed times are already known (as after prepare()) and a watcher on a fake clock.
 * Why: every test differs only in the test type, the metric readings and the overrides.
 * @param {string} testType
 * @param {(nowMs:number) => object|Error} readingAt Step SLA counters at a moment
 * @param {{overrides?:object, ringEndMs?:number}} [options]
 */
async function setUp(testType, readingAt, { overrides = {}, ringEndMs } = {}) {
  const clock = fakeClock(T0);
  const ctx = await buildCtx(testType, { overrides, scrape: fakeScrape(readingAt, clock.now) });
  const plan = describeRun(ctx);
  ctx.times.measureStart = toIsoWithOffset(new Date(RING_START));
  ctx.times.sendEnd = toIsoWithOffset(
    new Date(
      ringEndMs ??
        (plan.ratePerSecond > 0
          ? RING_START + ((plan.alarmCount - 1) / plan.ratePerSecond) * 1000
          : RING_START),
    ),
  );
  ctx.times.source = 'seed';
  ctx.times.markReady();
  const watcher = createAlarmWatcher(ctx, { plan, sleep: clock.sleep, now: clock.now });
  return { ctx, plan, clock, watcher };
}

/** Starts the watcher and waits for its outcome. */
async function watch(watcher) {
  await watcher.start();
  return watcher.whenDone();
}

/** Alarms that have rung by a moment, for a steady ring rate (0-based alarm n rings at start + n / rate). */
function rungBy(nowMs, count, rate) {
  if (nowMs < RING_START) return 0;
  return Math.min(count, Math.floor(((nowMs - RING_START) / 1000) * rate) + 1);
}

/** Steady readings: each alarm handled `lagMs` after it rings, at most `handledCap` in total. */
function steadyReadings({ count, rate, lagMs = 5000, handledCap = Infinity, cyclesFrom = 100 }) {
  return (nowMs) => {
    const rung = rungBy(nowMs, count, rate);
    const handled = Math.min(handledCap, rungBy(nowMs - lagMs, count, rate));
    return {
      due: rung - handled,
      applied: EARLIER_APPLIED + handled,
      skipped: 0,
      // The scheduler polls every 5 s: one more cycle each poll.
      cycles: cyclesFrom + Math.floor((nowMs - T0) / 5000),
      batchesFailed: 2,
    };
  };
}

describe('alarm watcher helpers', () => {
  it('median ignores nulls and handles even counts', () => {
    assert.equal(median([3, null, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([null]), null);
  });

  it('readAlarmCounters: handled = applied + skipped; a missing metric is null, not an error', () => {
    assert.deepEqual(readAlarmCounters(null), {
      due: null,
      applied: null,
      skipped: null,
      cycles: null,
      batchesFailed: null,
      handledTotal: null,
    });
  });

  it('createCycleCapCounter counts segments with >= 10,000 rows per cycle and the first time', () => {
    const counter = createCycleCapCounter();
    counter.update({ at: 'a', cycles: 10, handledTotal: 0 });
    counter.update({ at: 'b', cycles: 11, handledTotal: 9_999 }); // just under the cap
    counter.update({ at: 'c', cycles: 11, handledTotal: 15_000 }); // same cycle still running
    counter.update({ at: 'd', cycles: 12, handledTotal: 20_000 }); // 10,001 rows in one cycle → hit
    counter.update({ at: 'e', cycles: 14, handledTotal: 40_500 }); // 2 cycles, 20,500 rows → 2 hits
    assert.deepEqual(counter.result(), { value: 3, firstAt: 'd' });
    assert.equal(SLA_ROWS_PER_CYCLE_CAP, 10_000);
  });
});

describe('createAlarmWatcher', () => {
  it('smoke: caught up once every alarm is handled; catch-up = seconds after the last ring', async () => {
    const { ctx, watcher } = await setUp('smoke', steadyReadings({ count: 30, rate: 1 }));
    const outcome = await watch(watcher);

    assert.equal(outcome.name, 'alarms');
    assert.equal(outcome.subject, 'step-sla');
    assert.equal(outcome.aborted, undefined);
    // The last alarm rings 29 s after the first and is handled 5 s later (t = 34 s); the 5-s samples see it at
    // t = 35 s → 6 s after the last ring.
    assert.deepEqual(outcome.breaking, {
      caughtUp: true,
      catchUpSeconds: 6,
      remainingBacklog: 0,
      gaveUpAfterSeconds: null,
    });
    assert.ok(!('drainRate' in outcome.breaking), 'drain rate is reported for the storm only');
    assert.equal(
      outcome.load.eventsProcessed,
      30,
      'only the increase since the watch began counts',
    );
    const byId = Object.fromEntries(outcome.thresholds.map((t) => [t.id, t]));
    assert.equal(byId['step-sla.caught-up'].passed, true);
    assert.equal(byId['step-sla.caught-up'].actual, 0);
    assert.equal(byId['step-sla.batches-failed'].actual, 0);
    assert.equal(byId['step-sla.batches-failed'].passed, true);
    assert.equal(byId['step-sla.scheduler-alive'].passed, true);
    assert.ok(!byId['step-sla.drain-rate']);
    assert.deepEqual(outcome.peaks, { slaCycleCapHits: { value: 0, firstAt: null } });
    assert.deepEqual(ctx.aborts, []);

    // watch-alarms.json: every sample plus the outcome, written as the watch went.
    const file = JSON.parse(
      fs.readFileSync(path.join(ctx.resultsDir, 'watch-alarms.json'), 'utf8'),
    );
    assert.equal(file.name, 'alarms');
    assert.equal(file.intervalSeconds, 5);
    assert.equal(file.samples.length, outcome.samples.length);
    assert.equal(file.samples[0].phase, 'before-ring');
    assert.equal(file.samples.at(-1).phase, 'catch-up');
    assert.equal(file.samples.at(-1).t, 35); // seconds since the first alarm rang
    assert.equal(file.outcome.caughtUp, true);
    assert.equal(file.outcome.catchUpSeconds, 6);
    assert.equal(file.outcome.aborted, null);
  });

  it('not caught up: says so, never reports the give-up time as a catch-up (D19)', async () => {
    // Step SLA handles only 20 of the 30 alarms (10 due: not a stall, which needs > 10 waiting).
    const { ctx, watcher } = await setUp(
      'smoke',
      steadyReadings({ count: 30, rate: 1, handledCap: 20 }),
    );
    const outcome = await watch(watcher);
    assert.deepEqual(outcome.breaking, {
      caughtUp: false,
      catchUpSeconds: null,
      remainingBacklog: 10,
      gaveUpAfterSeconds: 120, // CATCH_UP_LIMIT
    });
    const caughtUp = outcome.thresholds.find((t) => t.id === 'step-sla.caught-up');
    assert.equal(caughtUp.passed, false);
    assert.equal(caughtUp.actual, 10);
    assert.match(caughtUp.description, /CATCH_UP_LIMIT/);
    // t counts from the first ring: the last alarm rang at t = 29 s, so it gave up at the first 5-s sample at
    // or after 29 + 120 = 149 s.
    assert.equal(outcome.samples.at(-1).t, 150);
    assert.equal(outcome.aborted, undefined);
    assert.deepEqual(ctx.aborts, []);
  });

  it('aborts when a counter goes down (Step SLA restarted)', async () => {
    const steady = steadyReadings({ count: 30, rate: 1 });
    const { ctx, watcher } = await setUp('smoke', (nowMs) => {
      const reading = steady(nowMs);
      // After a restart every counter starts from 0 again.
      return nowMs >= RING_START + 10_000 ? { ...reading, applied: 3, cycles: 1 } : reading;
    });
    const outcome = await watch(watcher);
    assert.match(outcome.aborted, /restarted/);
    assert.deepEqual(ctx.aborts, [outcome.aborted]);
    assert.equal(outcome.breaking.caughtUp, false);
    assert.equal(outcome.breaking.catchUpSeconds, null);
  });

  it('aborts when the scheduler stops (no cycle and nothing handled for STALL_TIMEOUT)', async () => {
    const { ctx, watcher } = await setUp('smoke', () => ({
      due: 0,
      applied: EARLIER_APPLIED,
      cycles: 100,
    }));
    const outcome = await watch(watcher);
    assert.match(
      outcome.aborted,
      /scheduler stopped: no evaluation cycle and nothing handled for 30 s/,
    );
    assert.equal(ctx.aborts.length, 1);
    assert.equal(outcome.samples.length, 7); // samples at 0, 5, … 30 s
  });

  it('aborts on a stall: alarms waiting and nothing handled for STALL_TIMEOUT', async () => {
    // Cycles keep running (scheduler alive) but only 10 alarms are ever handled while 20 wait.
    const { ctx, watcher } = await setUp(
      'smoke',
      steadyReadings({ count: 30, rate: 1, handledCap: 10 }),
    );
    const outcome = await watch(watcher);
    assert.match(
      outcome.aborted,
      /^stalled: Step SLA handled nothing for 30 s with \d+ alarms due/,
    );
    assert.equal(ctx.aborts.length, 1);
    assert.equal(outcome.breaking.caughtUp, false);
    assert.equal(outcome.breaking.remainingBacklog, 20);
  });

  it('a failed scrape is a gap and a warning, not an exception', async () => {
    const steady = steadyReadings({ count: 30, rate: 1 });
    const { watcher } = await setUp('smoke', (nowMs) =>
      nowMs === T0 + 10_000 ? new Error('connect ECONNREFUSED') : steady(nowMs),
    );
    const outcome = await watch(watcher);
    assert.equal(outcome.breaking.caughtUp, true);
    assert.deepEqual(outcome.warnings, [
      'alarm watcher: could not scrape Step SLA (connect ECONNREFUSED)',
    ]);
    const gap = outcome.samples[2];
    assert.equal(gap.due, null);
    assert.equal(gap.cycles, null);
  });

  it('storm: drain rate (median while > 1,000 due), cap hits, catch-up within BREAKPOINT_CATCH_UP_LIMIT', async () => {
    const count = 50_000;
    const { ctx, watcher } = await setUp(
      'breakpoint',
      (nowMs) => {
        const sinceRing = nowMs - RING_START;
        // Before the ring the scheduler polls every 5 s; once 50,000 are due, each cycle runs 100 batches and
        // takes 70 s, so the cycles counter moves only every 70 s while 150 alarms/s are handled.
        const cycles =
          sinceRing < 0
            ? 100 + Math.floor((nowMs - T0) / 5000)
            : 113 + Math.floor(sinceRing / 70_000);
        const handled = sinceRing < 0 ? 0 : Math.min(count, Math.floor((sinceRing / 1000) * 150));
        return {
          due: sinceRing < 0 ? 0 : count - handled,
          applied: EARLIER_APPLIED + handled,
          cycles,
        };
      },
      { overrides: { STEP_SLA_STORM_ALARMS: String(count) } },
    );
    const outcome = await watch(watcher);

    // 50,000 / 150 per second = 333.3 s; the next 5-s sample after that is 335 s after the ring.
    assert.equal(outcome.breaking.caughtUp, true);
    assert.equal(outcome.breaking.catchUpSeconds, 335);
    assert.equal(outcome.breaking.drainRate, 150);
    // Cycles that handled >= 10,000 rows: those ending at +70, +140, +210, +280 s.
    assert.equal(outcome.peaks.slaCycleCapHits.value, 4);
    assert.equal(
      outcome.peaks.slaCycleCapHits.firstAt,
      toIsoWithOffset(new Date(RING_START + 70_000)),
    );
    const drain = outcome.thresholds.find((t) => t.id === 'step-sla.drain-rate');
    // Expected: EXPECTED_HEADROOM (4) × STEP_SLA_PEAK_ALARM_RATE (auto: 50 × 1 DUE alarm per event, single).
    assert.equal(drain.limit, 200);
    assert.equal(drain.actual, 150);
    assert.equal(drain.passed, false);
    assert.equal(
      drain.informational,
      true,
      'the storm verdict is the catch-up, not the drain rate',
    );
    assert.equal(drain.unit, 'alarms/s');
    const caughtUp = outcome.thresholds.find((t) => t.id === 'step-sla.caught-up');
    assert.match(caughtUp.description, /BREAKPOINT_CATCH_UP_LIMIT/);
    assert.deepEqual(ctx.aborts, []);
    const file = JSON.parse(
      fs.readFileSync(path.join(ctx.resultsDir, 'watch-alarms.json'), 'utf8'),
    );
    assert.equal(file.outcome.drainRate, 150);
    assert.equal(file.outcome.slaCycleCapHits.value, 4);
  });

  it('whenDone before start() rejects with a clear message', async () => {
    const { watcher } = await setUp('smoke', steadyReadings({ count: 30, rate: 1 }));
    await assert.rejects(watcher.whenDone(), /never started/);
  });
});
