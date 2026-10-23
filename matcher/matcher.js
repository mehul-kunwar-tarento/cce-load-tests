// Load test for the matcher: k6 writes CloudEvents straight into Kafka, and a watcher reads the
// matcher's own counter to see whether it keeps up. The matcher has no HTTP endpoint to time.
//
// Flow:
//   setup()    once, first: notes the matcher's counters and the start time
//   default    the sender, once per event: builds a CloudEvent and writes it to Kafka (50/s or 200/s)
//   watch()    the watcher, alongside: every 5 s reads the counter, backlog = sent − processed;
//              stops the test if nothing is processed for 30 s; after sending ends, waits for the
//              backlog to clear and records catch-up time and average ms per event
//   sentBy()   events sent by t seconds, worked out from the schedule (virtual users share no counter)
//   readMetrics()  reads the numbers off the matcher's /actuator/prometheus page
// Pass: no Kafka errors, nothing dropped, backlog < 1,000, catch-up < 30 s.
//
// Run: ./run.sh local matcher/matcher.js                    (smoke, then load)
//      ./run.sh local matcher/matcher.js -e PROFILE=smoke   (smoke only)
//      ./run.sh local matcher/matcher.js -e PROFILE=stress  (smoke, then stress)
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import exec from 'k6/execution';
import { Producer } from 'k6/x/kafka';
import { optionsFor } from '../lib/options.js';

if (!__ENV.ENV) {
  throw new Error('Choose an environment, e.g. -e ENV=local');
}
const config = JSON.parse(open(`../env/${__ENV.ENV}.json`)).matcher;

const WATCH_EVERY = 5;     // seconds between two reads of the matcher's counter
const CATCH_UP_LIMIT = 120; // seconds the watcher waits for the backlog to clear after sending stops
const CAUGHT_UP = 10;      // a backlog this small counts as cleared (the schedule maths is off by a few)
const STALLED = 30;        // events waiting but none processed for this many seconds: stop the test

// --- Scenarios: the shared sending profile, plus one watcher -----------------------------------

const base = optionsFor(__ENV.PROFILE || 'full');

// When each sending scenario starts and how long it runs, in seconds (e.g. '30s', '10m').
const seconds = (d) => (d ? Number(d.slice(0, -1)) * (d.endsWith('m') ? 60 : 1) : 0);
const sending = Object.values(base.scenarios).map((s) => ({
  rate: s.rate,
  start: seconds(s.startTime),
  end: seconds(s.startTime) + seconds(s.duration),
}));
const SEND_END = Math.max(...sending.map((s) => s.end));

// Events sent by t seconds after the start. The sender runs at an exact rate (constant-arrival-rate),
// so this is known without counting; the dropped_iterations threshold makes sure it really was sent.
const sentBy = (t) => sending.reduce((n, s) => n + s.rate * Math.min(Math.max(t - s.start, 0), s.end - s.start), 0);

export const options = {
  scenarios: {
    ...base.scenarios,
    // One virtual user, one long iteration: reads the counter every 5 s until the backlog clears.
    watcher: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: `${SEND_END + CATCH_UP_LIMIT + 30}s`,
      exec: 'watch',
    },
  },
  thresholds: {
    ...base.thresholds,
    kafka_writer_error_count: ['count==0'], // every event reached Kafka, so a failure is the matcher's
    matcher_backlog: ['max<1000'],          // events waiting never passed 1,000 (5 s of traffic at 200/s)
    matcher_catch_up_seconds: ['max<30'],   // after sending stopped, the backlog cleared within 30 s
  },
};

const backlog = new Trend('matcher_backlog');
const throughput = new Trend('matcher_throughput');           // events per second, for the report
const catchUp = new Trend('matcher_catch_up_seconds');
const processingMs = new Trend('matcher_processing_ms', true); // average time per event, for the report

// --- Sender ------------------------------------------------------------------------------------

// One Kafka producer per virtual user, made once and reused for every event.
const producer = new Producer({ brokers: config.kafkaBrokers, topic: config.topic });

export default function () {
  // New IDs on every event; LOADTEST- marks the data as load-test data.
  const id = `${Date.now()}-${__VU}-${__ITER}`;
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

// Reads one number from the matcher's Prometheus page, e.g. cce_events_processed_total{...} 186126.0
function readMetrics() {
  const res = http.get(config.metricsUrl, { tags: { name: 'matcher metrics' } });
  check(res, { 'matcher metrics answered': (r) => r.status === 200 });
  const value = (name) => Number(res.body.match(new RegExp(`^${name}(?:\\{[^}]*\\})? (\\S+)$`, 'm'))[1]);
  return {
    processed: value('cce_events_processed_total'),
    timeSum: value('cce_events_processing_duration_seconds_sum'),
    timeCount: value('cce_events_processing_duration_seconds_count'),
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
  let lastProgress = 0; // seconds since start when the counter last went up
  let caughtUp = false;

  while (!caughtUp) {
    sleep(WATCH_EVERY);
    const now = readMetrics();
    const t = (Date.now() - data.t0) / 1000;
    const waiting = Math.max(sentBy(t) - (now.processed - data.first.processed), 0);

    backlog.add(waiting);
    throughput.add((now.processed - previous) / WATCH_EVERY);
    if (now.processed > previous) lastProgress = t;
    previous = now.processed;

    // Events are waiting but the matcher processed none for 30 s: Kafka is unreachable or the matcher
    // is down. Stop now instead of sending for minutes into nothing.
    if (waiting > CAUGHT_UP && t - lastProgress >= STALLED) {
      exec.test.abort(`Matcher processed nothing for ${STALLED} s with ${Math.round(waiting)} events waiting: is Kafka reachable and the matcher running?`);
    }
    if (Math.round(t) % 30 < WATCH_EVERY) {
      console.log(`t=${Math.round(t)}s sent=${Math.round(sentBy(t))} processed=${now.processed - data.first.processed} backlog=${Math.round(waiting)}`);
    }

    // After sending stops, wait for the backlog to clear, or give up after CATCH_UP_LIMIT seconds.
    if (t >= SEND_END && (waiting <= CAUGHT_UP || t >= SEND_END + CATCH_UP_LIMIT)) {
      catchUp.add(t - SEND_END);
      const counted = now.timeCount - data.first.timeCount;
      if (counted > 0) processingMs.add(((now.timeSum - data.first.timeSum) / counted) * 1000);
      caughtUp = true;
    }
  }
}
