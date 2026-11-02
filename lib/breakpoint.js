// Breakpoint: finds the rate at which an HTTP service breaks (test plan D1, D3, D4).
// A staircase after the 30-second smoke: 200 → 400 → 800 → 1600 → 3200 → 6400 requests/s, 1 minute per
// level. Each level is judged on its own with the load pass rules (p95 < 500 ms, < 1% errors,
// > 99% checks); the run stops at the first level that breaks one, so the report reads
// "handled X/s, broke at Y/s". Dropped requests with low latency mean k6 ran out, not the service (D4).
// A second, finer pass between the last good level and the broken one: -e LEVELS=1600,1800,2000,2200,...
import exec from 'k6/execution';

export const LEVELS = __ENV.LEVELS ? __ENV.LEVELS.split(',').map(Number) : [200, 400, 800, 1600, 3200, 6400];
const LEVEL_SECONDS = 60;
const START = 30; // seconds: right after the smoke

// Jump to each level in 1 s, then hold it for the rest of the minute.
export const breakpointScenario = {
  executor: 'ramping-arrival-rate',
  startRate: LEVELS[0],
  timeUnit: '1s',
  startTime: `${START}s`,
  stages: LEVELS.flatMap((rate) => [
    { duration: '1s', target: rate },
    { duration: `${LEVEL_SECONDS - 1}s`, target: rate },
  ]),
  preAllocatedVUs: 200,
  maxVUs: 1500,
};

// The load rules per level, on requests tagged with that level (see tagLevel). abortOnFail stops the run
// at the first broken level; delayAbortEval lets each level collect a few seconds of requests first.
const perLevel = (rule) => ({ threshold: rule, abortOnFail: true, delayAbortEval: '10s' });
export const breakpointThresholds = Object.fromEntries(
  LEVELS.flatMap((rate) => [
    [`http_req_duration{level:${rate}}`, [perLevel('p(95)<500')]],
    [`http_req_failed{level:${rate}}`, [perLevel('rate<0.01')]],
    [`checks{level:${rate}}`, [perLevel('rate>0.99')]],
    // Requests actually sent at this level, for the report: the target is rate × 60.
    [`iterations{level:${rate}}`, ['count>=0']],
  ]),
);
// Dropped requests aren't tagged with a level, so they count over the whole run: more than 1,000 means
// k6 can't keep the rate, and the report then says "at least X/s".
breakpointThresholds.dropped_iterations = [{ threshold: 'count<1000', abortOnFail: true }];

// Call first thing in each iteration: tags everything the iteration records with its level, e.g. level=800.
export function tagLevel() {
  if (exec.scenario.name !== 'breakpoint') return;
  const i = Math.floor((Date.now() - exec.scenario.startTime) / (LEVEL_SECONDS * 1000));
  exec.vu.metrics.tags.level = String(LEVELS[Math.min(i, LEVELS.length - 1)]);
}
