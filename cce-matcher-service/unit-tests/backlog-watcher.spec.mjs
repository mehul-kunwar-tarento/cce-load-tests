/**
 * backlog-watcher.spec.mjs — unit tests of the matcher backlog watcher (plan §6.5/§6.6).
 *
 * What:    Simulates whole matcher runs on a fake clock (minutes in milliseconds) with fake Kafka lag and
 *          fake matcher metrics, and checks what the watcher concludes: caught up after N s; NOT caught up
 *          (the v1 stress case: 11,474 events still waiting 120 s after sending — no catch-up number);
 *          times re-based when k6 reports "running" late; stall and restart stop the load; missing metrics
 *          never throw; sending that ended early; the flood's drain rate; dead letters; stop().
 * How:     npm test   (or: node --test cce-matcher-service/unit-tests/backlog-watcher.spec.mjs)
 * Needs:   ./fakes.mjs, ../watchers/backlog-watcher.mjs, ../shared.mjs. No network, no disk writes.
 * Outputs: node:test results.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildResult, validateResult } from '../shared.mjs';
import { buildBacklogOutcome, createBacklogWatcher, median } from '../watchers/backlog-watcher.mjs';
import {
  ENVIRONMENT,
  T0,
  createFakeClock,
  createFakeKafkaAdmin,
  createFakeScrape,
  createFakeTimes,
  createQuietLogger,
  defaultSettings,
  phasePlanFor,
} from './fakes.mjs';

/**
 * Builds a ctx and runs the watcher to its end on the fake clock.
 * Why: every scenario differs only in its lag/counter scripts and when the k6 clock becomes known.
 */
async function runScenario({
  testType = 'load',
  settings = defaultSettings(),
  lagAt,
  countersAt,
  dlqAt,
  readyAtSeconds = 0,
  k6StartSeconds = readyAtSeconds,
  schedule = () => {},
  withoutAdmin = false,
}) {
  const clock = createFakeClock();
  const phasePlan = phasePlanFor(testType, settings);
  const times = createFakeTimes();
  const aborts = [];
  const writes = [];
  const ctx = {
    environment: ENVIRONMENT,
    settings,
    phasePlan,
    resultsDir: '/fake/results/matcher-run',
    times,
    kafkaAdmin: withoutAdmin ? null : createFakeKafkaAdmin({ lagAt, dlqAt, clock }),
    scrape: createFakeScrape({ countersAt, clock }),
    logger: createQuietLogger(),
    abortLoad: (reason) => aborts.push(reason),
  };
  // The k6 clock becomes known when k6 reports "running" (after creating its VUs and producers).
  clock.at(T0 + readyAtSeconds * 1000, () => {
    times.setFromStart(T0 + k6StartSeconds * 1000, phasePlan);
    times.markReady();
  });
  schedule({ clock, times });
  const watcher = createBacklogWatcher(ctx, {
    now: clock.now,
    sleep: clock.sleep,
    // Keep a deep copy of every file write, to see what the file looked like at that moment.
    write: (file, data) => writes.push({ file, data: JSON.parse(JSON.stringify(data)) }),
  });
  await watcher.start();
  const outcome = await watcher.whenDone();
  return { outcome, aborts, writes, ctx, clock, times, phasePlan };
}

/** Steady matcher counters: `perSecond` events processed per second from t = 0, 4 ms each. */
const steady =
  (perSecond, extra = {}) =>
  (s) => {
    const n = Math.round(s * perSecond);
    return {
      matched: n,
      processingSum: n * 0.004,
      processingCount: n,
      processingMax: 0.03,
      ...extra,
    };
  };

/** Threshold by id; why: assertions read one rule at a time. */
const rule = (outcome, id) => outcome.thresholds.find((t) => t.id === id);

describe('backlog watcher: caught up', () => {
  it('reports the catch-up seconds after sending ended (load at 50/s)', async () => {
    const { outcome, aborts, writes } = await runScenario({
      // Warm-up 60 s, measure 600 s → sending ends at 660 s; 40 waiting until 670 s, then nothing.
      lagAt: (s) => (s < 660 ? 20 : s < 670 ? 40 : 0),
      countersAt: steady(50),
    });
    assert.deepEqual(aborts, []);
    assert.equal(outcome.name, 'backlog');
    assert.equal(outcome.breaking.caughtUp, true);
    assert.equal(outcome.breaking.catchUpSeconds, 10);
    assert.equal(outcome.breaking.gaveUpAfterSeconds, null);
    assert.equal(rule(outcome, 'matcher.backlog').passed, true);
    assert.equal(rule(outcome, 'matcher.backlog').actual, 40);
    assert.equal(rule(outcome, 'matcher.catch-up').passed, true);
    assert.equal(rule(outcome, 'matcher.catch-up').actual, 10);
    assert.equal(rule(outcome, 'matcher.dead-letters').passed, true);
    assert.equal(
      rule(outcome, 'matcher.drain-rate'),
      undefined,
      'no drain-rate rule outside the flood',
    );
    assert.equal(outcome.load.eventsProcessed, 670 * 50);
    assert.equal(outcome.summary.processingMsAvg, 4);
    assert.equal(outcome.summary.processingMaxMs, 30);
    assert.equal(outcome.breaking.startedBreakingAt, null);
    // Samples: absolute times every WATCH_INTERVAL from the watcher's own start; t relative to measureStart.
    assert.equal(outcome.samples.length, 670 / 5 + 1);
    assert.equal(outcome.samples[0].t, -60);
    assert.equal(new Date(outcome.samples[1].at) - new Date(outcome.samples[0].at), 5000);
    // Appended as it goes (one write per sample) plus the final write with the outcome.
    assert.equal(writes.length, outcome.samples.length + 1);
    assert.match(writes[0].file, /watch-backlog\.json$/);
    assert.equal(writes.at(-1).data.outcome.breaking.caughtUp, true);
    assert.equal(writes.at(-1).data.samples.length, outcome.samples.length);
  });
});

describe('backlog watcher: not caught up (v1 matcher-stress case)', () => {
  // 200/s for 600 s, backlog growing to 28,810 at the end of sending, then draining at ~144/s:
  // 11,474 events still waiting 120 s later (results/round-local-machine-20261103-0038/matcher-stress.log).
  const lagAt = (s) => {
    if (s < 60) return 0;
    if (s <= 660) return Math.round((s - 60) * (28810 / 600));
    return Math.max(0, Math.round(28810 - (s - 660) * ((28810 - 11474) / 120)));
  };

  it('gives up at the limit without a catch-up number', async () => {
    const { outcome, aborts } = await runScenario({
      testType: 'stress',
      lagAt,
      countersAt: steady(150),
    });
    assert.deepEqual(aborts, []);
    assert.equal(outcome.breaking.caughtUp, false);
    assert.equal(
      outcome.breaking.catchUpSeconds,
      null,
      'a give-up time is never a catch-up time (D19)',
    );
    assert.equal(outcome.breaking.remainingBacklog, 11474);
    assert.equal(outcome.breaking.gaveUpAfterSeconds, 120);
    const catchUp = rule(outcome, 'matcher.catch-up');
    assert.equal(catchUp.passed, false);
    assert.equal(catchUp.actual, null);
    const backlog = rule(outcome, 'matcher.backlog');
    assert.equal(backlog.passed, false);
    assert.equal(backlog.actual, 28810);
    assert.equal(backlog.rule, 'max <= 1000');
    // Started breaking: first of two samples in a row above 1,000, 25 s into the measured phase.
    assert.equal(outcome.breaking.secondsIntoMeasure, 25);
    assert.ok(outcome.breaking.startedBreakingAt);
    const words = outcome.breaking.whatBroke.map((w) => w.description);
    assert.ok(
      words.includes('not caught up: 11,474 events still waiting after 120 s'),
      words.join(' | '),
    );
    assert.ok(words.includes('up to 28,810 events waiting (rule ≤ 1,000)'));
    assert.equal(outcome.breaking.drainRate, 150);
  });

  it('fits result.json: validateResult accepts it and keeps catchUpSeconds null', async () => {
    const { outcome, phasePlan, times } = await runScenario({
      testType: 'stress',
      lagAt,
      countersAt: steady(150),
    });
    const settings = defaultSettings();
    const result = buildResult({
      context: {
        runId: settings.RUN_ID,
        service: 'cce-matcher-service',
        subject: 'matcher',
        testType: 'stress',
        startedAt: new Date(T0).toISOString(),
        dataset: null,
      },
      settings: { values: settings, sources: {}, derived: { phasePlan }, warnings: [] },
      phasePlan,
      watcherOutcomes: [outcome],
      timings: { times, watchersEndedAt: outcome.samples.at(-1).at, endedAt: T0 + 790_000 },
      module: { kind: 'k6', breakpointKind: 'flood' },
      k6ExitCode: 0,
      aborted: null,
      error: null,
      expectation: {
        summary: 'Withstand 200 events/s',
        targetRate: 200,
        peakRate: 50,
        multipleOfPeak: 4,
        unit: 'events',
        toBeConfirmed: true,
      },
      definitions: {},
    });
    assert.deepEqual(validateResult(result), []);
    assert.equal(result.breaking.caughtUp, false);
    assert.equal(result.breaking.catchUpSeconds, null);
    assert.equal(result.breaking.gaveUpAfterSeconds, 120);
    assert.equal(result.load.eventsProcessed, 780 * 150);
    assert.ok(result.timeSeries.points.some((p) => p.backlog === 28810));
  });
});

describe('backlog watcher: k6 clock contract', () => {
  it('re-bases samples when ctx.times.ready resolves late (k6 init took 47 s)', async () => {
    const { outcome, writes } = await runScenario({
      readyAtSeconds: 47,
      // measureStart = 47 + 60 = 107 s, sendEnd = 707 s (NOT 660 s from the docker start).
      lagAt: (s) => (s < 107 ? 0 : s < 715 ? 300 : 0),
      countersAt: steady(50),
    });
    // Before ready the sample had no t (written that way at 45 s) …
    const at45 = writes.find((w) => w.data.samples.length === 10);
    assert.equal(at45.data.samples[9].t, null);
    // … and afterwards every sample is re-based on the real measureStart.
    assert.equal(outcome.samples[0].t, -107);
    assert.equal(outcome.samples[9].t, 45 - 107);
    // Sending ended at 707 s; the backlog cleared at the 715 s sample: 8 s, not 55 s (715 − 660).
    assert.equal(outcome.breaking.caughtUp, true);
    assert.equal(outcome.breaking.catchUpSeconds, 8);
    assert.equal(
      outcome.samples.find((s) => s.t === 0),
      undefined,
      'samples stay on the watcher grid',
    );
  });

  it('follows sendEnd when k6 stops early and says so', async () => {
    const { outcome } = await runScenario({
      testType: 'stress',
      lagAt: (s) => (s < 200 ? 100 : 0),
      countersAt: steady(150),
      schedule: ({ clock, times }) =>
        // The runner moves sendEnd to the k6 exit time (abort rule, Ctrl-C) at 200 s.
        clock.at(T0 + 199_000, () => {
          times.sendEnd = new Date(T0 + 199_000).toISOString();
          times.sendEndedEarly = true;
        }),
    });
    assert.equal(outcome.breaking.caughtUp, true);
    assert.equal(outcome.breaking.catchUpSeconds, 1);
    assert.equal(outcome.summary.sendEndedEarly, true);
    assert.match(rule(outcome, 'matcher.catch-up').description, /sending ended early/);
  });
});

describe('backlog watcher: safe stops', () => {
  it('aborts the load on a stall (events waiting, nothing processed for STALL_TIMEOUT)', async () => {
    const { outcome, aborts } = await runScenario({
      lagAt: (s) => (s < 60 ? 0 : 500),
      countersAt: (s) => ({ matched: s < 60 ? s * 10 : 600 }),
    });
    assert.equal(aborts.length, 1);
    assert.match(aborts[0], /processed nothing for 30s with 500 events waiting/);
    assert.equal(outcome.aborted, aborts[0]);
    assert.equal(outcome.breaking.caughtUp, false);
    assert.equal(outcome.breaking.catchUpSeconds, null);
    assert.equal(outcome.breaking.gaveUpAfterSeconds, null, 'stopped before sending ended');
    assert.equal(outcome.samples.at(-1).t, 30, 'stopped 30 s after the last progress at 60 s');
    assert.ok(outcome.breaking.whatBroke.some((w) => w.metric === 'stall'));
  });

  it('aborts the load when the processed counter goes down (matcher restarted)', async () => {
    const { outcome, aborts } = await runScenario({
      lagAt: () => 5,
      countersAt: (s) => ({ matched: s < 100 ? s * 50 : 20 }),
    });
    assert.equal(aborts.length, 1);
    assert.match(aborts[0], /restarted.*went down from 4,750 to 20/);
    assert.equal(outcome.breaking.caughtUp, null, 'no catch-up verdict after a restart');
    assert.ok(outcome.breaking.whatBroke.some((w) => w.metric === 'restart'));
  });

  it('never throws on missing metrics: nulls, one warning each, and stall detection pauses', async () => {
    const { outcome, aborts, ctx } = await runScenario({
      lagAt: (s) => (s >= 20 && s < 30 ? new Error('broker gone') : s < 660 ? 50 : 0),
      countersAt: (s) =>
        s >= 20 && s < 40
          ? new Error('connect ECONNREFUSED')
          : s >= 40 && s < 80
            ? { matched: null } // matcher restarted without events yet: counter absent
            : steady(50)(s),
    });
    assert.deepEqual(aborts, [], 'missing data never aborts a run');
    assert.equal(outcome.breaking.caughtUp, true);
    const missing = outcome.samples.filter((s) => s.processed === null);
    assert.equal(missing.length, 12);
    assert.ok(outcome.samples.some((s) => s.backlog === null));
    assert.equal(outcome.warnings.length, 3);
    assert.ok(outcome.warnings.some((w) => /broker gone/.test(w)));
    assert.ok(outcome.warnings.some((w) => /ECONNREFUSED/.test(w)));
    assert.ok(outcome.warnings.some((w) => /cce_events_matched_total is missing/.test(w)));
    assert.equal(ctx.logger.lines.warn.length, 3, 'each kind of warning is logged once');
  });

  it('stop() ends the watch promptly with no catch-up verdict', async () => {
    const clock = createFakeClock();
    const times = createFakeTimes();
    const settings = defaultSettings();
    const ctx = {
      environment: ENVIRONMENT,
      settings,
      phasePlan: phasePlanFor('load', settings),
      resultsDir: '/fake',
      times,
      kafkaAdmin: createFakeKafkaAdmin({ lagAt: () => 0, clock }),
      scrape: createFakeScrape({ countersAt: steady(50), clock }),
      abortLoad: () => {},
    };
    let stopWatcher = null;
    const watcher = createBacklogWatcher(ctx, {
      now: clock.now,
      // The runner's Ctrl-C arrives while the watcher sleeps after its third sample.
      sleep: async (ms) => {
        await clock.sleep(ms);
        if (clock.elapsed() >= 15) await stopWatcher();
      },
      write: () => {},
    });
    stopWatcher = () => watcher.stop();
    await watcher.start();
    const outcome = await watcher.whenDone();
    assert.equal(outcome.summary.stopped, true);
    assert.equal(outcome.breaking.caughtUp, null);
    // Samples at 0, 5 and 10 s; the stop arrives during the following sleep, so no fourth sample is taken.
    assert.equal(outcome.samples.length, 3);
  });
});

describe('backlog watcher: flood and dead letters', () => {
  it('measures the drain rate of a flood and waits up to BREAKPOINT_CATCH_UP_LIMIT', async () => {
    const { outcome } = await runScenario({
      testType: 'breakpoint',
      // Flood 2,000/s from 60 s to 120 s; the matcher drains ~300/s, so 102,000 wait at 120 s.
      lagAt: (s) =>
        s < 60 ? 0 : s <= 120 ? (s - 60) * 1700 : Math.max(0, 102000 - (s - 120) * 300),
      countersAt: steady(300),
    });
    assert.equal(outcome.breaking.caughtUp, true);
    assert.equal(
      outcome.breaking.catchUpSeconds,
      340,
      'beyond CATCH_UP_LIMIT: the flood waits 15 min',
    );
    assert.equal(outcome.breaking.drainRate, 300);
    const drain = rule(outcome, 'matcher.drain-rate');
    assert.equal(drain.informational, true);
    assert.equal(drain.passed, true);
    assert.match(drain.description, /target ≥ 200 events\/s/);
    assert.equal(rule(outcome, 'matcher.backlog'), undefined, 'the flood is meant to pile up');
    assert.equal(rule(outcome, 'matcher.catch-up'), undefined);
    assert.ok(
      outcome.breaking.whatBroke.some((w) => /events waiting \(flood\)/.test(w.description)),
    );
  });

  it('fails matcher.dead-letters when the DLQ grows', async () => {
    const { outcome } = await runScenario({
      lagAt: (s) => (s < 660 ? 5 : 0),
      countersAt: steady(50),
      dlqAt: (s) => (s < 100 ? 5 : 8),
    });
    const dead = rule(outcome, 'matcher.dead-letters');
    assert.equal(dead.passed, false);
    assert.equal(dead.actual, 3);
    assert.deepEqual(outcome.summary.deadLetters, {
      topic: 'cce.events.inbound.dlq',
      start: 5,
      end: 8,
      delta: 3,
    });
    assert.ok(outcome.breaking.whatBroke.some((w) => w.metric === 'deadLetters'));
  });

  it('marks dead letters "not measured" (informational) when the DLQ cannot be read', async () => {
    const { outcome } = await runScenario({
      lagAt: (s) => (s < 660 ? 5 : 0),
      countersAt: steady(50),
      dlqAt: () => new Error('unknown topic'),
    });
    const dead = rule(outcome, 'matcher.dead-letters');
    assert.equal(dead.actual, null);
    assert.equal(dead.informational, true);
    assert.match(dead.description, /not measured/);
  });
});

describe('backlog watcher: pure helpers', () => {
  it('median ignores nulls and averages the middle pair', () => {
    assert.equal(median([null, 3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([null]), null);
  });

  it('buildBacklogOutcome without any lag reading fails the backlog rule as "not measured"', () => {
    const built = buildBacklogOutcome({
      samples: [{ at: new Date(T0).toISOString(), backlog: null, processed: null }],
      verdict: {
        caughtUp: false,
        catchUpSeconds: null,
        remainingBacklog: null,
        gaveUpAfterSeconds: 120,
      },
      settings: defaultSettings(),
      testType: 'load',
      measureStart: null,
      deadLetters: { topic: 't', start: 0, end: 0, delta: 0 },
    });
    const backlog = built.thresholds.find((t) => t.id === 'matcher.backlog');
    assert.equal(backlog.passed, false);
    assert.match(backlog.description, /not measured/);
    assert.equal(built.breaking.catchUpSeconds, null);
    assert.equal(built.load.eventsProcessed, null);
  });
});
