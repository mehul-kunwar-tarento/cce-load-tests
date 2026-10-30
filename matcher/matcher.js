// Load test for the matcher: k6 writes CloudEvents straight into Kafka, and a watcher reads the
// matcher's own counter to see whether it keeps up. The matcher has no HTTP endpoint to time.
//
// Flow:
//   setup()    once, first: notes the matcher's counters and the start time
//   default    the sender, once per event: builds a CloudEvent and writes it to Kafka
//              (load: 50/s for 10 min; stress: rising steps 100 → 400/s, 1 min each, lib/stress.js;
//              flood: 2,000/s for 1 min, lib/flood.js)
//   watch()    the watcher, alongside: every 5 s reads the counter, backlog = sent − processed;
//              stops the test if nothing is processed for 30 s or a counter goes down (restart);
//              after sending ends, waits for the backlog to clear and records catch-up time and
//              average ms per event
//   reportStaircase()  stress: each step kept up if the backlog grew by less than 5% of the events sent
//              in it; the first step that didn't is the breaking point ("kept up at X, broke at Y events/s")
//   reportFlood()  flood: the maximum = median throughput while the matcher was saturated
//              (backlog above 1,000 for the whole 5 s), printed as "broke above X events/s"
//   sentBy()   events sent by t seconds, worked out from the schedule (virtual users share no counter)
//   readMetrics()  reads the numbers off the matcher's /actuator/prometheus page
// Pass (load): no Kafka errors, nothing dropped, backlog < 1,000, catch-up < 30 s.
// Pass (stress, flood): no Kafka errors, nothing dropped, every sent event processed; the breaking point
// is the result.
//
// Run: ./run.sh local matcher/matcher.js                    (smoke, then load)
//      ./run.sh local matcher/matcher.js -e PROFILE=smoke   (smoke only)
//      ./run.sh local matcher/matcher.js -e PROFILE=stress  (smoke, then the staircase)
//      ./run.sh local matcher/matcher.js -e PROFILE=flood   (smoke, then the flood)
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import exec from 'k6/execution';
import { Producer } from 'k6/x/kafka';
import { optionsFor } from '../lib/options.js';
import { floodScenario } from '../lib/flood.js';
import { loadScenario } from '../lib/load.js';
import { STRESS_STEPS } from '../lib/stress.js';

if (!__ENV.ENV) {
  throw new Error('Choose an environment, e.g. -e ENV=local');
}
const config = JSON.parse(open(`../env/${__ENV.ENV}.json`)).matcher;

// run.sh gives every run an id; it goes into the test patient IDs so scripts/matcher-report.sh can count
// exactly this run's rows.
if (!__ENV.RUN_ID) {
  throw new Error('No RUN_ID: start the test with run.sh');
}
const RUN_ID = __ENV.RUN_ID;

let PROFILE = 'full';
if (__ENV.PROFILE) {
  PROFILE = __ENV.PROFILE;
}
const STAIRCASE = PROFILE === 'stress';
const FLOOD = PROFILE === 'flood';

const WATCH_EVERY = 5;     // seconds between two reads of the matcher's counter
const CAUGHT_UP = 10;      // a backlog this small counts as cleared (the schedule maths is off by a few)
const STALLED = 30;        // events waiting but none processed for this many seconds: stop the test
const SATURATED = 1000;    // a backlog above this means the matcher has more work than it can do
const KEPT_UP = 0.05;      // a staircase step kept up if its backlog grew by less than 5% of the events sent in it
const PEAK = loadScenario.rate; // the expected peak (50/s), to say how many times the peak it handles

// Seconds the watcher waits for the backlog to clear after sending stops: 2 min for load.
// Stress and flood push it past its limit and leave a pile (a flood ~120,000 events, about 7 min at
// 300/s), so they wait up to 15 min.
let CATCH_UP_LIMIT = 120;
if (STAIRCASE || FLOOD) {
  CATCH_UP_LIMIT = 900;
}

// --- Scenarios: the shared sending profile, plus one watcher -----------------------------------

const base = optionsFor(PROFILE);
const senders = base.scenarios; // the scenarios that send events

// Turns a k6 duration into seconds: '30s' → 30, '10m' → 600, nothing → 0.
function toSeconds(duration) {
  if (!duration) {
    return 0;
  }
  const number = Number(duration.slice(0, -1)); // '10m' → 10
  if (duration.endsWith('m')) {
    return number * 60;
  }
  return number;
}

// Each sending scenario as name + rate + start + end, in seconds,
// e.g. { name: 'step_300', rate: 300, start: 270, end: 330 }.
const sending = [];
for (const name of Object.keys(senders)) {
  const scenario = senders[name];
  const start = toSeconds(scenario.startTime);
  sending.push({ name: name, rate: scenario.rate, start: start, end: start + toSeconds(scenario.duration) });
}

// When the last scenario stops sending.
let SEND_END = 0;
for (const s of sending) {
  if (s.end > SEND_END) {
    SEND_END = s.end;
  }
}

// Events sent by t seconds after the start. The sender runs at an exact rate (constant-arrival-rate),
// so this is known without counting; the dropped_iterations threshold makes sure it really was sent.
function sentBy(t) {
  let total = 0;
  for (const s of sending) {
    let secondsSending = t - s.start;
    if (secondsSending < 0) {
      secondsSending = 0;                // not started yet
    }
    if (secondsSending > s.end - s.start) {
      secondsSending = s.end - s.start;  // already finished
    }
    total = total + s.rate * secondsSending;
  }
  return total;
}

// Pass rules: the shared ones, plus Kafka writes never failed.
const thresholds = { ...base.thresholds };
thresholds.kafka_writer_error_count = ['count==0']; // every event reached Kafka, so a failure is the matcher's

// The shared "p95 < 500 ms" is for services that answer HTTP requests. Here the only HTTP is the watcher
// reading the metrics page, so it would say nothing about the matcher: not used.
delete thresholds.http_req_duration;

// Load only: the matcher keeps up. Stress and flood break these on purpose; there the result is the
// breaking point, and the shared rules (nothing dropped, every sent event processed) still apply.
if (!STAIRCASE && !FLOOD) {
  thresholds.matcher_backlog = ['max<1000'];        // events waiting never passed 1,000
  thresholds.matcher_catch_up_seconds = ['max<30']; // after sending stopped, the backlog cleared within 30 s
}

export const options = {
  scenarios: {
    ...senders,
    // One virtual user, one long iteration: reads the counter every 5 s until the backlog clears.
    watcher: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: `${SEND_END + CATCH_UP_LIMIT + 30}s`,
      exec: 'watch',
    },
  },
  thresholds: thresholds,
};

const backlog = new Trend('matcher_backlog');
const throughput = new Trend('matcher_throughput');           // events per second, for the report
const catchUp = new Trend('matcher_catch_up_seconds');
const processingMs = new Trend('matcher_processing_ms', true); // average time per event, for the report
// Throughput only while the matcher had more work than it could do: its maximum, i.e. its breaking point.
const maxThroughput = new Trend('matcher_max_throughput');

// --- Sender ------------------------------------------------------------------------------------

// One Kafka producer per virtual user, made once and reused for every event.
const producer = new Producer({ brokers: config.kafkaBrokers, topic: config.topic });

export default function () {
  // New IDs on every event: LOADTEST-MATCH-<run id>-<virtual user>-<its event number>.
  // LOADTEST- marks it as load-test data; the run id lets scripts/matcher-report.sh find this run's rows.
  const id = `MATCH-${RUN_ID}-${__VU}-${__ITER}`;
  // Visit dated now, so protocol deadlines are in the future and Step SLA records no misses.
  const start = new Date();
  const end = new Date(start.getTime() + 15 * 60 * 1000);

  // The CloudEvent the collector publishes. The matcher skips a repeated id + source as a duplicate,
  // so the id must be new every time.
  const event = {
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: 'ebuzima',
    type: 'Encounter',
    subject: `LOADTEST-${id}`,
    time: start.toISOString(),
    facilityid: config.facilityId,
    datacontenttype: 'application/fhir+json',
    data: {
      resourceType: 'Encounter',
      id: `LOADTEST-ENC-${id}`,
      status: 'finished',
      class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
      subject: { reference: `Patient/LOADTEST-${id}` },
      period: { start: start.toISOString(), end: end.toISOString() },
    },
  };

  // Key = patient ID, as the collector does: all of one patient's events go to the same partition, in order.
  // If Kafka is unreachable, produce() doesn't fail: the write just waits. The watcher catches that
  // case instead (nothing processed for STALLED seconds stops the test).
  producer.produce({ messages: [{ key: event.subject, value: JSON.stringify(event) }] });
}

// --- Watcher -----------------------------------------------------------------------------------

// Finds one number on a Prometheus page. The page has lines like
//   cce_events_processed_total{application="cce-matcher-service"} 186126.0
// so: the line that starts with the name, skip the {...} labels, take the number after the space.
function readNumber(page, name) {
  const line = page.match(new RegExp(`^${name}(\\{[^}]*\\})? (\\S+)$`, 'm'));
  return Number(line[2]);
}

// Reads the matcher's counters from its Prometheus page.
function readMetrics() {
  const res = http.get(config.metricsUrl, { tags: { name: 'matcher metrics' } });
  check(res, { 'matcher metrics answered': (r) => r.status === 200 });
  return {
    processed: readNumber(res.body, 'cce_events_processed_total'),
    timeSum: readNumber(res.body, 'cce_events_processing_duration_seconds_sum'),
    timeCount: readNumber(res.body, 'cce_events_processing_duration_seconds_count'),
  };
}

// Runs once before the test starts: print where the load is going and note the counters' start values.
// The counter counts everything since the matcher started, so the test only looks at its increase.
export function setup() {
  console.log(`Target: Kafka ${config.kafkaBrokers.join(',')} topic ${config.topic}; watching ${config.metricsUrl}`);
  return { first: readMetrics(), t0: Date.now() };
}

export function watch(data) {
  let previous = data.first.processed;
  let previousWaiting = 0;
  let lastProgress = 0; // seconds since start when the counter last went up
  let caughtUp = false;
  const saturated = []; // flood: throughput readings taken while the matcher had more work than it could do

  // Stress: the staircase steps, with the backlog seen when each one started and ended.
  const steps = [];
  for (const s of sending) {
    if (s.name.startsWith('step_')) {
      steps.push({ rate: s.rate, start: s.start, end: s.end, backlogAtStart: null, backlogAtEnd: null });
    }
  }

  while (!caughtUp) {
    sleep(WATCH_EVERY);
    const now = readMetrics();
    const t = (Date.now() - data.t0) / 1000;
    const processedSoFar = now.processed - data.first.processed;
    let waiting = sentBy(t) - processedSoFar; // the backlog
    if (waiting < 0) {
      waiting = 0; // the schedule maths can be one event behind the matcher
    }
    const rate = (now.processed - previous) / WATCH_EVERY; // events per second over the last 5 s

    // A counter going down means the matcher restarted and its counters began again at 0.
    if (now.processed < previous) {
      exec.test.abort('Matcher counters went down: the service restarted during the test, so the numbers are not valid');
    }
    backlog.add(waiting);
    throughput.add(rate);
    // Saturated for the whole 5 s (backlog high at both ends): this reading is the matcher's maximum.
    if (previousWaiting > SATURATED && waiting > SATURATED) {
      maxThroughput.add(rate);
      saturated.push(rate);
    }
    if (now.processed > previous) {
      lastProgress = t;
    }
    previous = now.processed;
    previousWaiting = waiting;

    // The first reading after a step starts (and after it ends) gives its backlog at start (and end).
    for (const step of steps) {
      if (step.backlogAtStart === null && t >= step.start) {
        step.backlogAtStart = waiting;
      }
      if (step.backlogAtEnd === null && t >= step.end) {
        step.backlogAtEnd = waiting;
      }
    }

    // Events are waiting but the matcher processed none for 30 s: Kafka is unreachable or the matcher
    // is down. Stop now instead of sending for minutes into nothing.
    if (waiting > CAUGHT_UP && t - lastProgress >= STALLED) {
      exec.test.abort(`Matcher processed nothing for ${STALLED} s with ${Math.round(waiting)} events waiting: is Kafka reachable and the matcher running?`);
    }
    if (Math.round(t) % 30 < WATCH_EVERY) {
      console.log(`t=${Math.round(t)}s sent=${Math.round(sentBy(t))} processed=${processedSoFar} backlog=${Math.round(waiting)}`);
    }

    // After sending stops, wait for the backlog to clear, or give up after CATCH_UP_LIMIT seconds.
    const sendingDone = t >= SEND_END;
    const backlogCleared = waiting <= CAUGHT_UP;
    const waitedTooLong = t >= SEND_END + CATCH_UP_LIMIT;
    if (sendingDone && (backlogCleared || waitedTooLong)) {
      catchUp.add(t - SEND_END);

      // Average time per event during the test: total processing seconds ÷ events, in ms.
      const eventsTimed = now.timeCount - data.first.timeCount;
      if (eventsTimed > 0) {
        processingMs.add(((now.timeSum - data.first.timeSum) / eventsTimed) * 1000);
      }

      check(waiting, { 'every sent event processed': (w) => w <= CAUGHT_UP });
      if (STAIRCASE) {
        reportStaircase(steps, processedSoFar, t - SEND_END);
      }
      if (FLOOD) {
        reportFlood(saturated, processedSoFar, t - SEND_END);
      }
      caughtUp = true;
    }
  }
}

// Stress result: for each step, did the matcher keep up? The first step it didn't is the breaking point
// (test plan D2, D14). Kept up = the backlog grew by less than 5% of the events sent in that step.
function reportStaircase(steps, processed, catchUpSeconds) {
  let lastKeptUp = null;
  let brokeAt = null;

  console.log('Matcher stress, step by step:');
  for (const step of steps) {
    const sentInStep = step.rate * (step.end - step.start);
    const growth = step.backlogAtEnd - step.backlogAtStart;
    const keptUp = growth < sentInStep * KEPT_UP;

    let verdict = 'kept up';
    if (!keptUp) {
      verdict = 'fell behind';
    }
    console.log(`  ${step.rate} events/s: backlog ${Math.round(step.backlogAtStart)} → ${Math.round(step.backlogAtEnd)} (grew ${Math.round(growth)} of ${sentInStep} sent): ${verdict}`);

    if (keptUp && brokeAt === null) {
      lastKeptUp = step.rate;
    }
    if (!keptUp && brokeAt === null) {
      brokeAt = step.rate;
    }
  }

  const lastStep = steps[steps.length - 1].rate;
  if (brokeAt === null) {
    console.log(`Matcher breaking point: not reached. It kept up at every step up to ${lastStep} events/s`);
  } else if (lastKeptUp === null) {
    console.log(`Matcher breaking point: broke at the first step, ${brokeAt} events/s (${(brokeAt / PEAK).toFixed(1)} × the ${PEAK}/s peak)`);
  } else {
    console.log(`Matcher breaking point: kept up at ${lastKeptUp} events/s, broke at ${brokeAt} events/s (${(brokeAt / PEAK).toFixed(1)} × the ${PEAK}/s peak)`);
  }
  console.log(`  ${processed} events processed; backlog cleared ${Math.round(catchUpSeconds)} s after sending stopped`);
  console.log('  (with the matcher\'s current Kafka consumer setting, concurrency 3 by default)');
}

// Flood result: the matcher's maximum events per second, i.e. its breaking point (test plan D1, D2).
function reportFlood(rates, processed, catchUpSeconds) {
  if (rates.length === 0) {
    console.log(`Matcher breaking point: not reached. It kept up with the ${floodScenario.rate}/s flood, so it handles at least ${floodScenario.rate} events/s`);
    return;
  }
  // Sort the readings from slowest to fastest; the middle one is the median.
  const sorted = rates.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const slowest = sorted[0];
  const fastest = sorted[sorted.length - 1];
  const timesPeak = (median / PEAK).toFixed(1);

  console.log(`Matcher breaking point: broke above ${Math.round(median)} events/s (${timesPeak} × the ${PEAK}/s peak)`);
  console.log(`  saturated for ${rates.length * WATCH_EVERY} s: throughput min ${Math.round(slowest)} / median ${Math.round(median)} / max ${Math.round(fastest)} events/s`);
  console.log(`  ${processed} events processed; backlog cleared ${Math.round(catchUpSeconds)} s after sending stopped`);
  console.log('  (with the matcher\'s current Kafka consumer setting, concurrency 3 by default)');
}
