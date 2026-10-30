// Load test for Step SLA. The work is seeded straight into the database by scripts/step-sla-seed.sh: test steps whose
// deadline alarms ring at set times. This script only watches Step SLA handle them.
//
// Flow:
//   init       reads step-sla/last-seed.json (how many alarms, when the first and last ring)
//   setup()    once, first: notes Step SLA's counters
//   watch()    the watcher: every 5 s reads Step SLA's metrics page;
//              backlog = cce_sla_transitions_due (alarms rung but not handled, reported by Step SLA itself),
//              handled = increase in cce_sla_transitions_applied_total + _skipped_total;
//              stops the test if nothing is handled for 30 s while alarms wait, or if a counter goes down
//              (Step SLA restarted); ends when every seeded alarm is handled and records the catch-up time
//   readMetrics()  reads the numbers off /actuator/prometheus
// Pass here: every seeded alarm handled, all handled < 30 s after the last alarm rang (storm: < 5 min).
// The backlog is shown for information only: it depends on when the watcher looks (just before a
// 5 s check, 200/s already means 1,000 waiting). The real pass/fail is scripts/step-sla-report.sh: each alarm's wait.
//
// Run: DB_PASSWORD=<password> ./scripts/step-sla-seed.sh local stress && ./run.sh local step-sla/step-sla.js
//      then DB_PASSWORD=<password> ./scripts/step-sla-report.sh local
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import exec from 'k6/execution';

if (!__ENV.ENV) {
  throw new Error('Choose an environment, e.g. -e ENV=local');
}
const config = JSON.parse(open(`../env/${__ENV.ENV}.json`)).stepSla;
const seed = JSON.parse(open('./last-seed.json'));
if (seed.env !== __ENV.ENV) {
  throw new Error(`last-seed.json was seeded for ${seed.env}, not ${__ENV.ENV}: run scripts/step-sla-seed.sh first`);
}

const WATCH_EVERY = 5; // seconds between two reads of Step SLA's metrics
const STALLED = 30;    // alarms waiting but none handled for this many seconds: stop the test
const STORM = seed.profile === 'storm';

// Seconds after the last alarm rang to handle them all: 30 s, or 5 min for a storm (100,000 at once).
let CATCH_UP_TARGET = 30;
if (STORM) {
  CATCH_UP_TARGET = 300;
}
const CATCH_UP_LIMIT = CATCH_UP_TARGET * 2; // the watcher gives up waiting after this

// How long the watcher may run: until the last alarm rings, plus the catch-up limit, plus 30 s spare.
let secondsUntilLastRing = Math.ceil((seed.ringEnd - Date.now()) / 1000);
if (secondsUntilLastRing < 0) {
  secondsUntilLastRing = 0;
}
const WATCH_AT_MOST = secondsUntilLastRing + CATCH_UP_LIMIT + 30;

export const options = {
  scenarios: {
    // One virtual user, one long iteration: watches until every seeded alarm is handled.
    watcher: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: `${WATCH_AT_MOST}s`,
      exec: 'watch',
    },
  },
  thresholds: {
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
    step_sla_catch_up_seconds: [`max<${CATCH_UP_TARGET}`],
  },
};

const backlog = new Trend('step_sla_backlog');       // alarms waiting, for the report (no pass/fail)
const throughput = new Trend('step_sla_throughput'); // alarms handled per second, for the report
const catchUp = new Trend('step_sla_catch_up_seconds');

// Finds one number on a Prometheus page. The page has lines like
//   cce_sla_transitions_due{application="cce-step-sla-service"} 0.0
// so: the line that starts with the name, skip the {...} labels, take the number after the space.
function readNumber(page, name) {
  const line = page.match(new RegExp(`^${name}(\\{[^}]*\\})? (\\S+)$`, 'm'));
  return Number(line[2]);
}

// Reads Step SLA's numbers: alarms due now, and alarms handled so far (applied + skipped).
function readMetrics() {
  const res = http.get(config.metricsUrl, { tags: { name: 'step sla metrics' } });
  check(res, { 'step sla metrics answered': (r) => r.status === 200 });
  const applied = readNumber(res.body, 'cce_sla_transitions_applied_total');
  const skipped = readNumber(res.body, 'cce_sla_transitions_skipped_total');
  return {
    due: readNumber(res.body, 'cce_sla_transitions_due'),
    handled: applied + skipped,
  };
}

// Seconds from now until a time in milliseconds (negative if it is past).
function secondsFromNow(ms) {
  return Math.round((ms - Date.now()) / 1000);
}

// Runs once before the test starts: print what is being watched and note the counters' start values.
// The counters count everything since Step SLA started, so the test only looks at their increase.
export function setup() {
  console.log(`Watching ${config.metricsUrl}: ${seed.count} alarms (${seed.profile}), first rings in ${secondsFromNow(seed.ringStart)} s, last in ${secondsFromNow(seed.ringEnd)} s`);
  if (seed.ringEnd + CATCH_UP_LIMIT * 1000 < Date.now()) {
    throw new Error('last-seed.json is from an earlier run (its alarms rang long ago): run scripts/step-sla-seed.sh again');
  }
  return { first: readMetrics() };
}

export function watch(data) {
  let previous = data.first.handled;
  let lastProgress = Date.now(); // when the handled counter last went up
  let done = false;

  while (!done) {
    sleep(WATCH_EVERY);
    const now = readMetrics();
    const handled = now.handled - data.first.handled;
    const sinceLastRing = (Date.now() - seed.ringEnd) / 1000; // negative while alarms are still to ring

    // A counter going down means Step SLA restarted and its counters began again at 0.
    if (now.handled < previous) {
      exec.test.abort('Step SLA counters went down: the service restarted during the test, so the numbers are not valid');
    }
    backlog.add(now.due);
    throughput.add((now.handled - previous) / WATCH_EVERY);
    // Progress = the counter went up, or nothing is waiting (before the first alarm rings, Step SLA has
    // nothing to do, which is not a stall).
    if (now.handled > previous || now.due <= 10) {
      lastProgress = Date.now();
    }
    previous = now.handled;

    // Alarms are waiting but Step SLA handled none for 30 s: it is down or stuck.
    if (now.due > 10 && (Date.now() - lastProgress) / 1000 >= STALLED) {
      exec.test.abort(`Step SLA handled nothing for ${STALLED} s with ${now.due} alarms due: is it running?`);
    }
    if (Math.round(Date.now() / 1000) % 30 < WATCH_EVERY) {
      console.log(`handled=${handled}/${seed.count} due=${now.due}`);
    }

    // Done once every seeded alarm is handled, or give up CATCH_UP_LIMIT seconds after the last one rang.
    if (handled >= seed.count || sinceLastRing >= CATCH_UP_LIMIT) {
      let catchUpSeconds = sinceLastRing;
      if (catchUpSeconds < 0) {
        catchUpSeconds = 0; // all handled before the last alarm's time (cannot really happen, but safe)
      }
      check(handled, { 'every seeded alarm handled': (n) => n >= seed.count });
      catchUp.add(catchUpSeconds);
      console.log(`handled=${handled}/${seed.count}, ${catchUpSeconds.toFixed(1)} s after the last alarm rang`);
      done = true;
    }
  }
}
