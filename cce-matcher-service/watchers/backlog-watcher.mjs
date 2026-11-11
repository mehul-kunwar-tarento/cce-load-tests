/**
 * backlog-watcher.mjs — follows the matcher's Kafka backlog during a test and decides whether it kept up.
 *
 * What:    The matcher has no HTTP endpoint that k6 could time: it reads events from the Kafka topic
 *          cce.events.inbound. So "is it keeping up?" is answered from outside, every WATCH_INTERVAL:
 *            backlog   = consumer-group lag (events in Kafka the matcher has not committed yet; the matcher
 *                        commits after its database transaction, so lag 0 means everything is stored)
 *            processed = sum(cce_events_matched_total) + cce_events_duplicate_total (cce_events_processed_total
 *                        is not used: it counts retries twice)
 *          plus the processing-time counters, inbound errors and the dead-letter topic (DLQ) size.
 *          After sending ends it waits until the backlog is (almost) empty — "caught up after N s" — or
 *          gives up after CATCH_UP_LIMIT (BREAKPOINT_CATCH_UP_LIMIT for the flood) — "not caught up: N events
 *          still waiting after S s" (never reported as a catch-up time: the v1 bug, D19). It stops the load
 *          early (ctx.abortLoad) when nothing is processed for STALL_TIMEOUT while events wait, or when the
 *          matcher's counter goes down (it restarted). Times follow the k6 clock contract: the watcher
 *          samples from its own start, but uses measureStart / sendEnd only once ctx.times.ready resolved,
 *          and re-bases earlier samples then (k6 may need a long time to create its Kafka producers).
 * How:     Declared in service-module.mjs (`watchers: [(ctx) => createBacklogWatcher(ctx)]`); the shared
 *          runner starts it before k6 and waits for whenDone(). Unit tests inject a fake clock:
 *          createBacklogWatcher(ctx, { now, sleep, write }).
 * Needs:   ctx (plan §6.4): environment.kafka (matcherConsumerGroup, inboundTopic, deadLetterTopic),
 *          kafkaAdmin (getGroupLag, getTopicEndOffsetTotal), scrape('matcher'), times (k6 clock), settings
 *          (WATCH_INTERVAL, CATCH_UP_LIMIT, BREAKPOINT_CATCH_UP_LIMIT, STALL_TIMEOUT, MATCHER_MAX_BACKLOG,
 *          MATCHER_MAX_CATCH_UP, MATCHER_MAX_DEAD_LETTERS, BREAK_CONSECUTIVE_WINDOWS, EXPECTED_HEADROOM,
 *          PEAK_RATE), phasePlan, resultsDir, abortLoad, logger.
 * Outputs: results/<run>/watch-backlog.json (rewritten after every sample) and a WatcherOutcome
 *          { name, subject, file, samples, thresholds, breaking, load, aborted, summary, warnings } (plan §6.5).
 */
import {
  analyseBacklogSeries,
  createSampleLog,
  createStallDetector,
  formatNumber,
  formatSeconds,
  isCounterReset,
  maxMetric,
  sumMetric,
  toIsoWithOffset,
} from '../shared.mjs';

/** Name of the watcher; the sample file is watch-backlog.json. */
export const WATCHER_NAME = 'backlog';

/** A backlog this small counts as caught up (plan §6.6): a few events are always in flight. */
export const CAUGHT_UP_BACKLOG = 10;

/** Stall detection only applies with more than this many events waiting (plan §6.5). */
export const STALL_MIN_BACKLOG = 10;

/** How often (in samples) a progress line is logged, so a long run shows it is alive. */
const LOG_EVERY_SAMPLES = 6;

/** Default sleep; unit tests inject one that moves a fake clock instead. */
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Milliseconds of an ISO time, or null; why: ctx.times holds ISO strings that may still be null. */
function msOf(iso) {
  if (iso === null || iso === undefined) return null;
  const value = new Date(iso).getTime();
  return Number.isFinite(value) ? value : null;
}

/** Rounds to one decimal; why: sample times and rates are read by people, 0.1 s is precise enough. */
function round1(value) {
  return value === null || value === undefined ? null : Math.round(value * 10) / 10;
}

/**
 * Median of the numbers in a list (null when there are none).
 * Why: the drain rate is the median of the per-sample rates, so one slow or fast sample does not move it.
 * @param {Array<number|null>} values
 * @returns {number|null}
 */
export function median(values) {
  const numbers = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!numbers.length) return null;
  numbers.sort((a, b) => a - b);
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

/**
 * Reads one raw measurement: the consumer lag and the matcher counters. Never throws.
 * Why: plan §6.5 — a missing metric (matcher restarting, scrape timeout) must give null and a warning,
 * not a crashed watcher (v1 threw a TypeError when its regex found nothing).
 * @param {object} ctx run ctx
 * @param {(key:string, message:string) => void} warn records a warning once per key
 * @returns {Promise<{backlog:number|null, processed:number|null, processingSum:number|null,
 *           processingCount:number|null, processingMax:number|null, inboundErrors:number|null}>}
 */
export async function readMatcherState(ctx, warn) {
  const kafka = ctx.environment?.kafka ?? {};
  let backlog = null;
  if (!ctx.kafkaAdmin) {
    warn('no-admin', 'no Kafka admin client: the backlog (consumer lag) cannot be measured');
  } else {
    try {
      const lag = await ctx.kafkaAdmin.getGroupLag({
        groupId: kafka.matcherConsumerGroup,
        topic: kafka.inboundTopic,
      });
      backlog = typeof lag?.total === 'number' ? lag.total : null;
      if (backlog === null) warn('lag-shape', 'the Kafka admin returned no lag total');
    } catch (error) {
      warn('lag', `could not read the matcher consumer lag: ${error.message}`);
    }
  }
  let parsed = null;
  try {
    parsed = await ctx.scrape('matcher');
  } catch (error) {
    warn('scrape', `could not scrape the matcher metrics: ${error.message}`);
  }
  // sumMetric adds EVERY series (matched + zero_match), and returns null when the metric is absent.
  const matched = parsed ? sumMetric(parsed, 'cce_events_matched_total') : null;
  const duplicates = parsed ? sumMetric(parsed, 'cce_events_duplicate_total') : null;
  if (parsed && matched === null) {
    warn('matched', 'cce_events_matched_total is missing from the matcher metrics');
  }
  // Both absent → unknown; only one absent counts as 0 (no duplicate since the matcher started).
  const processed =
    matched === null && duplicates === null ? null : (matched ?? 0) + (duplicates ?? 0);
  const read = (name, aggregate = sumMetric) => (parsed ? aggregate(parsed, name) : null);
  return {
    backlog,
    processed,
    processingSum: read('cce_events_processing_duration_seconds_sum'),
    processingCount: read('cce_events_processing_duration_seconds_count'),
    processingMax: read('cce_events_processing_duration_seconds_max', maxMetric),
    inboundErrors: read('cce_consumer_inbound_errors_total'),
  };
}

/**
 * Size of the dead-letter topic (sum of its end offsets), or null when it cannot be read.
 * Why: events the matcher could not handle end up there; growth during the run = dead letters.
 */
async function readDeadLetterTotal(ctx, warn) {
  const topic = ctx.environment?.kafka?.deadLetterTopic;
  if (!topic) {
    warn('dlq-topic', 'kafka.deadLetterTopic is not configured: dead letters not measured');
    return null;
  }
  if (!ctx.kafkaAdmin) return null;
  try {
    const total = await ctx.kafkaAdmin.getTopicEndOffsetTotal(topic);
    return typeof total === 'number' ? total : null;
  } catch (error) {
    warn('dlq', `could not read the dead-letter topic ${topic}: ${error.message}`);
    return null;
  }
}

/**
 * Turns the samples and the final state into the watcher's thresholds, breaking facts and load figures.
 * Why: a pure function (no clock, no I/O), so every rule is unit-tested on plain data.
 * @param {object} input
 * @param {object[]} input.samples watch-backlog.json samples ({at, backlog, processed, drainRate, …})
 * @param {object} input.verdict how the watch ended: {caughtUp, catchUpSeconds, remainingBacklog,
 *   gaveUpAfterSeconds, aborted?, abortKind?, stopped?}
 * @param {Record<string, any>} input.settings ResolvedSettings.values
 * @param {string} input.testType smoke | load | stress | breakpoint
 * @param {string|null} input.measureStart ISO (k6 clock)
 * @param {{start:number|null, end:number|null, delta:number|null, topic:string|null}} input.deadLetters
 * @param {boolean} [input.sendEndedEarly]
 * @returns {{thresholds:object[], breaking:object, load:object, summary:object}}
 */
export function buildBacklogOutcome({
  samples,
  verdict,
  settings,
  testType,
  measureStart,
  deadLetters,
  sendEndedEarly = false,
}) {
  const isBreakpoint = testType === 'breakpoint';
  const maxAllowed = settings.MATCHER_MAX_BACKLOG;
  const maxCatchUp = settings.MATCHER_MAX_CATCH_UP;
  const catchUpLimit = isBreakpoint ? settings.BREAKPOINT_CATCH_UP_LIMIT : settings.CATCH_UP_LIMIT;
  const maxDeadLetters = settings.MATCHER_MAX_DEAD_LETTERS;

  // "Started breaking" = first sample of the measured phase that starts N samples in a row above the limit.
  const series = analyseBacklogSeries({
    samples,
    limit: maxAllowed,
    consecutive: settings.BREAK_CONSECUTIVE_WINDOWS,
    measureStart,
  });
  const maxBacklog = series.maxBacklog;
  const drainRate = median(samples.map((s) => s.drainRate));

  // Counter figures over the whole watch: first and last readable values.
  const first = (key) => samples.find((s) => typeof s[key] === 'number')?.[key] ?? null;
  const last = (key) =>
    [...samples].reverse().find((s) => typeof s[key] === 'number')?.[key] ?? null;
  const processedFirst = first('processed');
  const processedLast = last('processed');
  const eventsProcessed =
    processedFirst !== null && processedLast !== null && processedLast >= processedFirst
      ? processedLast - processedFirst
      : null;
  const errorsFirst = first('inboundErrors');
  const errorsLast = last('inboundErrors');
  const processingSumFirst = first('processingSum');
  const processingSumLast = last('processingSum');
  const processingCountFirst = first('processingCount');
  const processingCountLast = last('processingCount');
  const countDelta =
    processingCountFirst !== null && processingCountLast !== null
      ? processingCountLast - processingCountFirst
      : null;
  const processingMsAvg =
    countDelta > 0 ? ((processingSumLast - processingSumFirst) / countDelta) * 1000 : null;
  const maxima = samples.map((s) => s.processingMaxMs).filter((v) => typeof v === 'number');
  const processingMaxMs = maxima.length ? Math.max(...maxima) : null;

  const thresholds = [];
  const earlyNote = sendEndedEarly ? ' (sending ended early)' : '';
  if (!isBreakpoint) {
    thresholds.push({
      id: 'matcher.backlog',
      metric: 'backlog',
      rule: `max <= ${maxAllowed}`,
      limit: maxAllowed,
      actual: maxBacklog,
      unit: 'events',
      passed: maxBacklog !== null && maxBacklog <= maxAllowed,
      toBeConfirmed: true, // MATCHER_MAX_BACKLOG is "to be confirmed from UAT/Dev data"
      source: 'watcher',
      description:
        `Events waiting in Kafka never above ${formatNumber(maxAllowed)}` +
        (maxBacklog === null ? ' (not measured: consumer lag unreadable)' : ''),
    });
    thresholds.push({
      id: 'matcher.catch-up',
      metric: 'catchUpSeconds',
      rule: `caught up within ${maxCatchUp} s`,
      limit: maxCatchUp,
      // Only a real catch-up is a number; a give-up time never is (D19).
      actual: verdict.caughtUp === true ? verdict.catchUpSeconds : null,
      unit: 's',
      passed: verdict.caughtUp === true && verdict.catchUpSeconds <= maxCatchUp,
      toBeConfirmed: true, // MATCHER_MAX_CATCH_UP is "to be confirmed"
      source: 'watcher',
      description: `Caught up within ${formatSeconds(maxCatchUp)} after sending stopped${earlyNote}`,
    });
  }
  const dlqMeasured = typeof deadLetters?.delta === 'number';
  thresholds.push({
    id: 'matcher.dead-letters',
    metric: 'deadLetters',
    rule: `count <= ${maxDeadLetters}`,
    limit: maxDeadLetters,
    actual: dlqMeasured ? deadLetters.delta : null,
    unit: 'events',
    passed: dlqMeasured && deadLetters.delta <= maxDeadLetters,
    toBeConfirmed: false,
    source: 'watcher',
    description: dlqMeasured
      ? 'No new dead-letter records'
      : 'No new dead-letter records (not measured: dead-letter topic unreadable)',
    // An unmeasured rule is shown but never decides the verdict (it is neither a pass nor a failure).
    ...(dlqMeasured ? {} : { informational: true }),
  });
  if (isBreakpoint) {
    const target = settings.EXPECTED_HEADROOM * settings.PEAK_RATE;
    thresholds.push({
      id: 'matcher.drain-rate',
      metric: 'drainRate',
      rule: 'median > 0',
      limit: 0,
      actual: drainRate,
      unit: 'events/s',
      passed: drainRate !== null && drainRate > 0,
      toBeConfirmed: true,
      source: 'watcher',
      description: `Matcher keeps draining the backlog (target ≥ ${formatNumber(target)} events/s)`,
      // The flood finds the capacity; the drain rate is reported against the target, not judged.
      informational: true,
    });
  }

  // "What broke", in plain words, with the same metric names as the thresholds above.
  const whatBroke = [];
  if (maxBacklog !== null && maxBacklog > maxAllowed) {
    whatBroke.push({
      metric: 'backlog',
      description: isBreakpoint
        ? `up to ${formatNumber(maxBacklog)} events waiting (flood)`
        : `up to ${formatNumber(maxBacklog)} events waiting (rule ≤ ${formatNumber(maxAllowed)})`,
      actual: maxBacklog,
      limit: maxAllowed,
      source: 'watcher',
    });
  }
  if (verdict.caughtUp === false && !verdict.aborted) {
    whatBroke.push({
      metric: 'catchUpSeconds',
      description: `not caught up: ${formatNumber(verdict.remainingBacklog)} events still waiting after ${formatNumber(verdict.gaveUpAfterSeconds)} s`,
      actual: verdict.remainingBacklog,
      limit: isBreakpoint ? catchUpLimit : maxCatchUp,
      source: 'watcher',
    });
  }
  if (dlqMeasured && deadLetters.delta > maxDeadLetters) {
    whatBroke.push({
      metric: 'deadLetters',
      description: `${formatNumber(deadLetters.delta)} events went to the dead-letter topic ${deadLetters.topic} (rule ≤ ${formatNumber(maxDeadLetters)})`,
      actual: deadLetters.delta,
      limit: maxDeadLetters,
      source: 'watcher',
    });
  }
  if (verdict.aborted) {
    whatBroke.push({
      metric: verdict.abortKind ?? 'watcher',
      description: verdict.aborted,
      actual: verdict.remainingBacklog ?? null,
      limit: null,
      source: 'watcher',
    });
  }

  return {
    thresholds,
    breaking: {
      startedBreakingAt: series.startedBreakingAt,
      secondsIntoMeasure: series.secondsIntoMeasure,
      whatBroke,
      caughtUp: verdict.caughtUp ?? null,
      catchUpSeconds: verdict.caughtUp === true ? verdict.catchUpSeconds : null,
      remainingBacklog: verdict.remainingBacklog ?? null,
      gaveUpAfterSeconds: verdict.caughtUp === false ? (verdict.gaveUpAfterSeconds ?? null) : null,
      drainRate: drainRate === null ? null : round1(drainRate),
    },
    load: { eventsProcessed },
    summary: {
      maxBacklog,
      eventsProcessed,
      processingMsAvg: processingMsAvg === null ? null : round1(processingMsAvg),
      processingMaxMs,
      inboundErrors:
        errorsFirst !== null && errorsLast !== null ? Math.max(0, errorsLast - errorsFirst) : null,
      deadLetters: deadLetters ?? { start: null, end: null, delta: null, topic: null },
      catchUpLimitSeconds: catchUpLimit,
      sendEndedEarly: Boolean(sendEndedEarly),
      stopped: Boolean(verdict.stopped),
    },
  };
}

/**
 * Creates the matcher backlog watcher (plan §6.5 Watcher contract).
 * Why: the runner treats every watcher the same way: start(), then whenDone() → WatcherOutcome.
 * @param {object} ctx run ctx (plan §6.4)
 * @param {{now?:() => number, sleep?:(ms:number) => Promise<void>, write?:Function}} [deps] fakes for tests
 * @returns {{name:string, start():Promise<void>, stop():Promise<void>, whenDone():Promise<object>}}
 */
export function createBacklogWatcher(ctx, deps = {}) {
  const { now = Date.now, sleep = realSleep, write } = deps;
  const settings = ctx.settings;
  const testType = ctx.phasePlan?.testType ?? ctx.context?.testType ?? 'load';
  const intervalSeconds = settings.WATCH_INTERVAL;
  const intervalMs = intervalSeconds * 1000;
  // How long to wait after sending ended: 2 min normally, 15 min after a flood (defaults).
  const limitSeconds =
    testType === 'breakpoint' ? settings.BREAKPOINT_CATCH_UP_LIMIT : settings.CATCH_UP_LIMIT;
  const log = createSampleLog({
    name: WATCHER_NAME,
    resultsDir: ctx.resultsDir,
    intervalSeconds,
    write,
  });
  const stall = createStallDetector({
    stallSeconds: settings.STALL_TIMEOUT,
    minBacklog: STALL_MIN_BACKLOG,
  });
  const warnings = [];
  const warned = new Set();
  /** Records a warning once per kind; why: a missing metric would otherwise warn every 5 s. */
  const warn = (key, message) => {
    if (warned.has(key)) return;
    warned.add(key);
    warnings.push(message);
    ctx.logger?.warn?.(`backlog watcher: ${message}`);
  };

  // The k6 clock: measureStart/sendEnd may be used only after ctx.times.ready (never the docker start).
  let timesReady = false;
  Promise.resolve(ctx.times?.ready).then(() => {
    timesReady = true;
  });
  let rebasedFrom = null; // measureStart (ms) the sample `t` values were last computed from

  let startMs = null;
  let stopped = false;
  let finished = false;
  let wakeUp;
  const stopSignal = new Promise((resolve) => {
    wakeUp = resolve;
  });
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  let deadLetterStart = null;
  let previous = null; // previous raw reading (with atMs), for per-second rates
  let lastProcessed = null; // last readable processed counter, for restart detection

  /** measureStart / sendEnd in ms once the k6 clock is known; why: re-read every sample (sendEnd may move). */
  function knownTimes() {
    if (!timesReady) return null;
    const measureStartMs = msOf(ctx.times.measureStart);
    const sendEndMs = msOf(ctx.times.sendEnd);
    return measureStartMs === null || sendEndMs === null ? null : { measureStartMs, sendEndMs };
  }

  /** Recomputes `t` (seconds since measureStart) of every sample; why: samples taken before ready had none. */
  function rebase(measureStartMs) {
    if (rebasedFrom === measureStartMs) return;
    for (const sample of log.samples) sample.t = round1((msOf(sample.at) - measureStartMs) / 1000);
    rebasedFrom = measureStartMs;
  }

  /** Ends the watch: reads the DLQ again, builds the outcome, writes the file, resolves whenDone(). */
  async function finish(verdict) {
    if (finished) return;
    finished = true;
    const deadLetterEnd = await readDeadLetterTotal(ctx, warn);
    const deadLetters = {
      topic: ctx.environment?.kafka?.deadLetterTopic ?? null,
      start: deadLetterStart,
      end: deadLetterEnd,
      delta:
        deadLetterStart !== null && deadLetterEnd !== null
          ? Math.max(0, deadLetterEnd - deadLetterStart)
          : null,
    };
    const built = buildBacklogOutcome({
      samples: log.samples,
      verdict,
      settings,
      testType,
      measureStart: timesReady ? ctx.times.measureStart : null,
      deadLetters,
      sendEndedEarly: Boolean(ctx.times?.sendEndedEarly),
    });
    const outcome = {
      name: WATCHER_NAME,
      subject: 'matcher',
      file: log.file,
      thresholds: built.thresholds,
      breaking: built.breaking,
      load: built.load,
      aborted: verdict.aborted ?? null,
      summary: { ...built.summary, timesSource: ctx.times?.source ?? null },
      warnings,
    };
    // The file keeps the samples once (data.samples) and the outcome without them.
    log.finish(outcome);
    resolveDone({ ...outcome, samples: log.samples });
  }

  /** Stops the load through the runner and returns the verdict of an aborted watch. */
  function abort(reason, kind, backlog, atMs, times) {
    ctx.abortLoad?.(reason);
    const afterSend = times && atMs >= times.sendEndMs;
    return {
      aborted: reason,
      abortKind: kind,
      // A restart makes the counters meaningless: no catch-up verdict at all.
      caughtUp: kind === 'restart' ? null : false,
      catchUpSeconds: null,
      remainingBacklog: backlog,
      gaveUpAfterSeconds:
        kind === 'stall' && afterSend ? round1((atMs - times.sendEndMs) / 1000) : null,
    };
  }

  /**
   * Takes one sample and decides whether the watch is over.
   * @returns {Promise<object|null>} verdict when done, else null
   */
  async function sampleOnce(index) {
    const atMs = now();
    const raw = await readMatcherState(ctx, warn);
    const times = knownTimes();
    if (times) rebase(times.measureStartMs);

    // Per-second rates from the previous reading (absolute times, not the nominal interval).
    const seconds = previous ? (atMs - previous.atMs) / 1000 : null;
    const delta = (key) =>
      previous && typeof raw[key] === 'number' && typeof previous[key] === 'number'
        ? raw[key] - previous[key]
        : null;
    const processedDelta = delta('processed');
    const processedPerSecond =
      processedDelta !== null && seconds > 0 && processedDelta >= 0
        ? round1(processedDelta / seconds)
        : null;
    const countDelta = delta('processingCount');
    const sumDelta = delta('processingSum');
    const sample = {
      at: toIsoWithOffset(atMs),
      t: times ? round1((atMs - times.measureStartMs) / 1000) : null,
      backlog: raw.backlog,
      processed: raw.processed,
      processedPerSecond,
      // Drain rate: how fast it works while it is clearly saturated (more than the backlog limit waiting).
      drainRate:
        raw.backlog !== null && raw.backlog > settings.MATCHER_MAX_BACKLOG
          ? processedPerSecond
          : null,
      processingMsAvg: countDelta > 0 ? round1((sumDelta / countDelta) * 1000) : null,
      processingMaxMs: raw.processingMax === null ? null : raw.processingMax * 1000,
      processingSum: raw.processingSum,
      processingCount: raw.processingCount,
      inboundErrors: raw.inboundErrors,
      // true while k6 should still be sending; null while the k6 clock is not known yet.
      sending: times ? atMs < times.sendEndMs : null,
    };
    log.add(sample);
    previous = { ...raw, atMs };
    if (index % LOG_EVERY_SAMPLES === 0) {
      ctx.logger?.info?.(
        `backlog ${formatNumber(raw.backlog)}, processed ${formatNumber(processedPerSecond)}/s` +
          (sample.t === null ? '' : ` (t=${sample.t} s)`),
      );
    }

    // A counter that goes down means the matcher restarted: its numbers no longer add up → stop.
    if (isCounterReset(lastProcessed, raw.processed)) {
      return abort(
        `the matcher restarted during the test: its processed counter went down from ${formatNumber(lastProcessed)} to ${formatNumber(raw.processed)}`,
        'restart',
        raw.backlog,
        atMs,
        times,
      );
    }
    if (raw.processed !== null) {
      lastProcessed = raw.processed;
      // Stall: events waiting but none processed for STALL_TIMEOUT (Kafka unreachable, matcher stuck).
      // Paused while the counter is unreadable: missing data never aborts a run.
      if (stall.update({ atMs, backlog: raw.backlog, progress: raw.processed })) {
        return abort(
          `the matcher processed nothing for ${formatSeconds(settings.STALL_TIMEOUT)} with ${formatNumber(raw.backlog)} events waiting: is Kafka reachable and the matcher running?`,
          'stall',
          raw.backlog,
          atMs,
          times,
        );
      }
    }

    // Done rules (plan §6.6) apply only after sending ended, on the k6 clock.
    if (!times || atMs < times.sendEndMs) return null;
    const sinceSendEnd = round1((atMs - times.sendEndMs) / 1000);
    if (raw.backlog !== null && raw.backlog <= CAUGHT_UP_BACKLOG) {
      return {
        caughtUp: true,
        catchUpSeconds: sinceSendEnd,
        remainingBacklog: raw.backlog,
        gaveUpAfterSeconds: null,
      };
    }
    if (atMs - times.sendEndMs >= limitSeconds * 1000) {
      return {
        caughtUp: false,
        catchUpSeconds: null,
        remainingBacklog: raw.backlog,
        gaveUpAfterSeconds: sinceSendEnd,
      };
    }
    return null;
  }

  /** The sampling loop: one sample per interval, aligned on the watcher's own start (no drift). */
  async function loop() {
    for (let index = 0; ; index += 1) {
      if (stopped) return finish({ stopped: true, caughtUp: null });
      const verdict = await sampleOnce(index);
      if (verdict) return finish(verdict);
      const waitMs = Math.max(0, startMs + (index + 1) * intervalMs - now());
      // Wake up early when stop() is called (Ctrl-C), so the run ends promptly.
      await Promise.race([sleep(waitMs), stopSignal]);
    }
  }

  return {
    name: WATCHER_NAME,
    /** Starts sampling; returns after the first DLQ reading (the loop keeps running). */
    async start() {
      startMs = now();
      deadLetterStart = await readDeadLetterTotal(ctx, warn);
      loop().catch((error) => {
        // Never lose the run: an unexpected error ends the watch with what was collected.
        warn('loop', `backlog watcher stopped by an error: ${error.message}`);
        return finish({ stopped: true, caughtUp: null });
      });
    },
    /** Stops sampling (Ctrl-C); the outcome then has caughtUp null. */
    async stop() {
      stopped = true;
      wakeUp();
    },
    whenDone: () => done,
  };
}
