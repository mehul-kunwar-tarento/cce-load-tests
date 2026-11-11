/**
 * k6-clock.mjs — learns, while k6 runs, the moment it started measuring (the k6 clock contract, plan §4.7).
 *
 * What:    Starting a k6 container takes time (image start, creating up to thousands of virtual users,
 *          one Kafka producer each). k6's scenario times count from the end of setup(), not from
 *          `docker run`. Watchers and the report need the real instant the measured phase began, so
 *          this clock polls k6's REST API (GET /v1/status). As soon as k6 reports "running", it sets:
 *            k6StartedAt  = poll time
 *            measureStart = k6StartedAt + measured phase startSeconds   (warm-up excluded)
 *            sendEnd      = measureStart + measured phase durationSeconds
 *          and resolves times.ready. If the API never answers within 60 s of the container start, it
 *          falls back to the container start time (source 'estimated', a warning in the result).
 *          After the run the result builder replaces these with k6StartedAt from k6-summary.json.
 * How:     const times = createTimes();
 *          const clock = startK6Clock({ apiUrl: 'http://127.0.0.1:6565', phasePlan, times, containerStartedAt });
 *          await times.ready; …; clock.stop();
 * Needs:   The k6 REST API (--address) reachable from the runner; tests pass a fake getJson.
 * Outputs: Mutates `times`: { k6StartedAt, measureStart, sendEnd, sendEndedEarly, source, warnings, ready }.
 */
import { getJson as realGetJson } from './clients/http-json.mjs';
import { toIsoWithOffset } from './format.mjs';
import { measuredPhaseOf } from './lib-bridge.mjs';

/** How long the API may stay unreachable before the clock estimates (plan §6.3). */
export const API_FALLBACK_MS = 60_000;

/**
 * Creates the shared, mutable times object (ctx.times, plan §6.3).
 * Why: watchers, the runner and the result builder all read the same instants; `ready` lets watchers
 * wait until the start is known.
 * @returns {{k6StartedAt:string|null, measureStart:string|null, sendEnd:string|null, sendEndedEarly:boolean,
 *           source:string|null, warnings:string[], ready:Promise<void>, markReady:()=>void}}
 */
export function createTimes() {
  let markReady;
  const ready = new Promise((resolve) => {
    markReady = resolve;
  });
  const times = {
    k6StartedAt: null,
    measureStart: null,
    sendEnd: null,
    sendEndedEarly: false,
    source: null,
    warnings: [],
  };
  // Non-enumerable: JSON.stringify(times) shows the instants, not the promise machinery.
  Object.defineProperty(times, 'ready', { value: ready, enumerable: false });
  Object.defineProperty(times, 'markReady', { value: () => markReady(), enumerable: false });
  return times;
}

/**
 * Sets the measured-phase instants from a k6 start moment.
 * Why: the same arithmetic for the live clock, the estimate, and the re-basing after the run.
 * @param {object} times createTimes() object
 * @param {object} phasePlan
 * @param {number} k6StartedAtMs
 * @param {string} source 'k6-rest-api' | 'estimated' | 'k6-setup'
 */
export function setTimesFromStart(times, phasePlan, k6StartedAtMs, source) {
  const measured = measuredPhaseOf(phasePlan);
  const measureStartMs = k6StartedAtMs + measured.startSeconds * 1000;
  times.k6StartedAt = toIsoWithOffset(k6StartedAtMs);
  times.measureStart = toIsoWithOffset(measureStartMs);
  times.sendEnd = toIsoWithOffset(measureStartMs + measured.durationSeconds * 1000);
  times.source = source;
}

/**
 * True when a /v1/status answer says k6 is running (after setup()).
 * Why: k6 versions report it as `running: true`, status "running" or the numeric status 7; all accepted.
 * @param {any} body
 * @returns {boolean}
 */
export function isK6Running(body) {
  const attributes = body?.data?.attributes ?? {};
  return attributes.running === true || attributes.status === 'running' || attributes.status === 7;
}

/**
 * Starts polling the k6 REST API.
 * @param {object} input
 * @param {string} input.apiUrl e.g. 'http://127.0.0.1:6565'
 * @param {object} input.phasePlan
 * @param {object} input.times from createTimes()
 * @param {number} [input.pollMs] poll interval (accuracy of the live start time)
 * @param {(url:string, o:object)=>Promise<{status:number, body:any}>} [input.getJson] injectable for tests
 * @param {number} [input.containerStartedAtMs] when `docker run` was started (fallback origin)
 * @param {number} [input.fallbackAfterMs] default 60 s
 * @param {() => number} [input.now]
 * @returns {{stop(): void, done: Promise<void>}}
 */
export function startK6Clock({
  apiUrl,
  phasePlan,
  times,
  pollMs = 250,
  getJson = realGetJson,
  containerStartedAtMs = Date.now(),
  fallbackAfterMs = API_FALLBACK_MS,
  now = Date.now,
}) {
  let stopped = false;
  let timer = null;
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  let lastAnswerMs = null; // last time the API answered at all

  const settle = () => {
    stopped = true;
    times.markReady?.();
    finish();
  };

  const poll = async () => {
    if (stopped) return;
    const polledAt = now();
    try {
      const { status, body } = await getJson(`${apiUrl}/v1/status`, {
        timeoutMs: Math.max(pollMs, 500),
      });
      if (status === 200) {
        lastAnswerMs = polledAt;
        if (isK6Running(body)) {
          setTimesFromStart(times, phasePlan, polledAt, 'k6-rest-api');
          settle();
          return;
        }
      }
    } catch {
      // Not up yet (or gone): keep polling until the fallback deadline.
    }
    // Never answered for fallbackAfterMs after the container started → estimate from the start.
    if (lastAnswerMs === null && now() - containerStartedAtMs >= fallbackAfterMs) {
      setTimesFromStart(times, phasePlan, containerStartedAtMs, 'estimated');
      times.warnings.push(
        `k6 REST API ${apiUrl} did not answer within ${Math.round(fallbackAfterMs / 1000)} s: ` +
          'times estimated from the container start until k6-summary.json corrects them',
      );
      settle();
      return;
    }
    if (!stopped) timer = setTimeout(poll, pollMs);
  };
  timer = setTimeout(poll, 0);

  return {
    done,
    stop() {
      if (timer) clearTimeout(timer);
      if (!stopped) {
        stopped = true;
        finish();
      }
    },
  };
}
