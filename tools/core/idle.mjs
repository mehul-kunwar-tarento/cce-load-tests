/**
 * idle.mjs — "is the service idle?" checks shared by the service modules (plan §6.3, §6.6, §6.7).
 *
 * What:    CCE's counters are global and the services share one Postgres, so a test must start only
 *          when the services have finished the previous work (lesson: a draining matcher slowed the
 *          collector). Matcher (also used before collector runs): Kafka lag 0 AND processed counter flat
 *          for IDLE_FLAT_DURATION. Step SLA: cce_sla_transitions_due <= 0 for IDLE_FLAT_DURATION.
 *          Waiting longer than IDLE_TIMEOUT refuses the run (exit 2).
 * How:     await waitForMatcherIdle(ctx, { flatSeconds: 30, timeoutSeconds: 300 });
 * Needs:   ctx.kafkaAdmin, ctx.scrape(subject), ctx.environment, ctx.settings (fakes in tests).
 * Outputs: { waitedSeconds }; readMatcherBacklog → { lag, processed }; RefusedError on timeout.
 */
import { maxMetric, sumMetric } from './clients/prometheus-text.mjs';
import { RefusedError } from './errors.mjs';

/** Default sleep; tests inject an instant one. */
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Current matcher backlog and processed-event counter.
 * Why: the backlog is the consumer-group lag (Kafka admin), "processed" the matcher's own counters.
 * @param {object} ctx
 * @returns {Promise<{lag:number|null, processed:number|null}>}
 */
export async function readMatcherBacklog(ctx) {
  const { kafka } = ctx.environment;
  let lag = null;
  try {
    lag = (
      await ctx.kafkaAdmin.getGroupLag({
        groupId: kafka.matcherConsumerGroup,
        topic: kafka.inboundTopic,
      })
    ).total;
  } catch (error) {
    ctx.logger?.warn?.(`could not read the matcher consumer lag: ${error.message}`);
  }
  let processed = null;
  try {
    const parsed = await ctx.scrape('matcher');
    const matched = sumMetric(parsed, 'cce_events_matched_total');
    const duplicates = sumMetric(parsed, 'cce_events_duplicate_total');
    // Both absent → unknown; one absent counts as 0 (e.g. no duplicate yet since start-up).
    processed = matched === null && duplicates === null ? null : (matched ?? 0) + (duplicates ?? 0);
  } catch (error) {
    ctx.logger?.warn?.(`could not scrape the matcher: ${error.message}`);
  }
  return { lag, processed };
}

/**
 * Polls until a condition has held for flatSeconds, or throws RefusedError after timeoutSeconds.
 * Why: both idle checks share the timing logic; `isQuiet(prev, current)` decides per sample.
 */
async function waitUntilFlat({
  read,
  isQuiet,
  flatSeconds,
  timeoutSeconds,
  pollSeconds,
  sleep,
  now,
  what,
}) {
  const startMs = now();
  let quietSinceMs = null;
  let previous = null;
  for (;;) {
    const current = await read();
    const quiet = isQuiet(previous, current);
    quietSinceMs = quiet ? (quietSinceMs ?? now()) : null;
    if (quietSinceMs !== null && now() - quietSinceMs >= flatSeconds * 1000) {
      return { waitedSeconds: Math.round((now() - startMs) / 1000) };
    }
    if (now() - startMs >= timeoutSeconds * 1000) {
      throw new RefusedError(
        `${what} is still busy after ${timeoutSeconds} s (IDLE_TIMEOUT): wait for it to finish or check it ` +
          `(last reading ${JSON.stringify(current)})`,
      );
    }
    previous = current;
    await sleep(pollSeconds * 1000);
  }
}

/**
 * Waits until the matcher is idle: lag 0 and the processed counter unchanged for flatSeconds.
 * @param {object} ctx
 * @param {{flatSeconds?:number, timeoutSeconds?:number, pollSeconds?:number, sleep?:Function, now?:Function}} [options]
 * @returns {Promise<{waitedSeconds:number}>}
 */
export async function waitForMatcherIdle(ctx, options = {}) {
  const {
    flatSeconds = ctx.settings.IDLE_FLAT_DURATION,
    timeoutSeconds = ctx.settings.IDLE_TIMEOUT,
    pollSeconds = Math.min(5, ctx.settings.WATCH_INTERVAL ?? 5),
    sleep = realSleep,
    now = Date.now,
  } = options;
  return waitUntilFlat({
    read: () => readMatcherBacklog(ctx),
    // Quiet = nothing waiting and nothing processed since the previous sample.
    isQuiet: (previous, current) =>
      current.lag === 0 && previous !== null && current.processed === previous.processed,
    flatSeconds,
    timeoutSeconds,
    pollSeconds,
    sleep,
    now,
    what: 'The matcher',
  });
}

/**
 * Waits until Step SLA has no due alarms (cce_sla_transitions_due <= 0) for flatSeconds.
 * @param {object} ctx
 * @param {{flatSeconds?:number, timeoutSeconds?:number, pollSeconds?:number, sleep?:Function, now?:Function}} [options]
 * @returns {Promise<{waitedSeconds:number}>}
 */
export async function waitForStepSlaIdle(ctx, options = {}) {
  const {
    flatSeconds = ctx.settings.IDLE_FLAT_DURATION,
    timeoutSeconds = ctx.settings.IDLE_TIMEOUT,
    pollSeconds = Math.min(5, ctx.settings.WATCH_INTERVAL ?? 5),
    sleep = realSleep,
    now = Date.now,
  } = options;
  return waitUntilFlat({
    read: async () => ({ due: maxMetric(await ctx.scrape('step-sla'), 'cce_sla_transitions_due') }),
    isQuiet: (_previous, current) => current.due !== null && current.due <= 0,
    flatSeconds,
    timeoutSeconds,
    pollSeconds,
    sleep,
    now,
    what: 'Step SLA',
  });
}
