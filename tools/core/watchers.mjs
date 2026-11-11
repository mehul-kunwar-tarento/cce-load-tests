/**
 * watchers.mjs — runs the service watchers of a test and offers the helpers they share (plan §6.5).
 *
 * What:    Queue-based services (matcher, Step SLA) are measured by Node "watchers" that sample a backlog
 *          every WATCH_INTERVAL until it clears or a limit passes. This module starts every watcher a
 *          service module declares, waits for all of them, and collects their outcomes even if one fails.
 *          It also provides the building blocks every watcher needs: an append-as-you-go sample file
 *          (an abort keeps the data), counter-reset detection (a restarted service → abort) and stall
 *          detection (backlog > 10 with no progress for STALL_TIMEOUT → abort).
 * How:     const run = startWatchers(module.watchers ?? [], ctx); const outcomes = await run.whenDone();
 * Needs:   Watcher factories (ctx) => { name, start(), stop(), whenDone() } (B modules).
 * Outputs: WatcherOutcome[] = { name, file, samples, thresholds, breaking, load, peaks?, aborted?, error? }.
 */
import path from 'node:path';
import { toIsoWithOffset } from './format.mjs';
import { writeJson } from './results.mjs';

/**
 * Starts every watcher.
 * Why: the runner treats watchers uniformly; a failing watcher becomes an outcome with `error`, so the
 * other watchers' data and the run's result are not lost.
 * @param {Array<(ctx:object) => {name:string, start():Promise<void>, stop():Promise<void>, whenDone():Promise<object>}>} factories
 * @param {object} ctx run context object (plan §6.4)
 * @returns {{watchers: object[], whenDone(): Promise<object[]>, stopAll(): Promise<void>}}
 */
export function startWatchers(factories, ctx) {
  const watchers = factories.map((factory) => factory(ctx));
  const started = watchers.map((watcher) =>
    Promise.resolve()
      .then(() => watcher.start())
      .catch((error) => {
        ctx.logger?.warn?.(`watcher ${watcher.name} failed to start: ${error.message}`);
        throw error;
      }),
  );
  return {
    watchers,
    async whenDone() {
      return Promise.all(
        watchers.map(async (watcher, i) => {
          try {
            await started[i];
            return await watcher.whenDone();
          } catch (error) {
            return {
              name: watcher.name,
              file: null,
              samples: [],
              thresholds: [],
              breaking: {},
              load: {},
              error: error.message,
            };
          }
        }),
      );
    },
    async stopAll() {
      await Promise.all(watchers.map((watcher) => Promise.resolve(watcher.stop()).catch(() => {})));
    },
  };
}

/**
 * A watch-<name>.json file that is rewritten after every sample.
 * Why: plan §6.5 — samples are saved as they come, so Ctrl-C or a crash keeps everything so far.
 * @param {{name:string, resultsDir:string, intervalSeconds:number, write?:Function}} input
 * @returns {{file:string, samples:object[], add(sample:object):void, finish(outcome:object):void, data:object}}
 */
export function createSampleLog({ name, resultsDir, intervalSeconds, write = writeJson }) {
  const file = path.join(resultsDir, `watch-${name}.json`);
  const data = { schemaVersion: '1.0.0', name, intervalSeconds, samples: [], outcome: null };
  return {
    file,
    data,
    samples: data.samples,
    add(sample) {
      data.samples.push({ at: toIsoWithOffset(new Date()), ...sample });
      write(file, data);
    },
    finish(outcome) {
      data.outcome = outcome;
      write(file, data);
    },
  };
}

/**
 * True when a counter went down between two samples.
 * Why: counters only grow; a decrease means the service restarted mid-test → the run is aborted.
 * @param {number|null} previous
 * @param {number|null} current
 * @returns {boolean}
 */
export function isCounterReset(previous, current) {
  return typeof previous === 'number' && typeof current === 'number' && current < previous;
}

/**
 * Detects a stall: more than `minBacklog` waiting and the progress counter unchanged for stallSeconds.
 * Why: plan §6.5 — e.g. Kafka unreachable makes k6 block and the matcher stop; waiting the full
 * catch-up limit would only hide it. The report then says "stalled: no progress for 30 s".
 * @param {{stallSeconds:number, minBacklog?:number}} options
 * @returns {{update(input:{atMs:number, backlog:number|null, progress:number|null}): boolean}} update → true once stalled
 */
export function createStallDetector({ stallSeconds, minBacklog = 10 }) {
  let lastProgress = null;
  let lastChangeMs = null;
  return {
    update({ atMs, backlog, progress }) {
      if (progress !== lastProgress || lastChangeMs === null) {
        lastProgress = progress;
        lastChangeMs = atMs;
        return false;
      }
      return (
        typeof backlog === 'number' &&
        backlog > minBacklog &&
        atMs - lastChangeMs >= stallSeconds * 1000
      );
    },
  };
}
