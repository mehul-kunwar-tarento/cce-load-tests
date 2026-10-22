// Load test for the OpenHIM emitter adaptor (eBUZIMA → adaptor → collector).
// Run: ./run.sh local adaptor/openhim.js                    (smoke, then load)
//      ./run.sh local adaptor/openhim.js -e PROFILE=smoke   (smoke only)
//      ./run.sh local adaptor/openhim.js -e PROFILE=stress  (smoke, then a staircase to find the breaking point)
import http from 'k6/http';
import { check } from 'k6';

if (!__ENV.ENV) {
  throw new Error('Choose an environment, e.g. -e ENV=local');
}
const config = JSON.parse(open(`../env/${__ENV.ENV}.json`)).openhimAdaptor;

const PROFILE = __ENV.PROFILE || 'full';
if (!['full', 'smoke', 'stress'].includes(PROFILE)) {
  throw new Error(`PROFILE must be full, smoke or stress, not ${PROFILE}`);
}

// Smoke: 1 request per second for 30 seconds, to prove the script and setup work.
const smoke = {
  executor: 'constant-arrival-rate',
  rate: 1,
  timeUnit: '1s',
  duration: '30s',
  preAllocatedVUs: 2,
};

// Load: 100 requests per second for 5 minutes (the adaptor's documented target), after the smoke.
const load = {
  executor: 'constant-arrival-rate',
  rate: 100,
  timeUnit: '1s',
  duration: '5m',
  startTime: '30s',
  preAllocatedVUs: 50, // virtual users ready at the start
  maxVUs: 200,         // k6 may add more if the adaptor slows down, up to this
};

// Pass/fail rules for the load run.
const loadThresholds = {
  http_req_duration: ['p(95)<500'], // 95% of requests answered within 500 ms
  http_req_failed: ['rate<0.01'],   // under 1% of requests get a 4xx/5xx
  checks: ['rate>0.99'],            // over 99% pass the checks below (catches "200 skipped")
  dropped_iterations: ['count==0'], // k6 always managed to send at the set rate
};

// If the smoke fails, stop at once instead of sending thousands of bad requests.
const smokeAbort = {
  'checks{scenario:smoke}': [{ threshold: 'rate>0.99', abortOnFail: true }],
};

// Stress: one step per level, 1 minute each, one after another after the smoke.
// Each step is its own scenario (stress_100, stress_200, ...), so the summary shows pass/fail per level
// with the same rules as the load run. The first level that fails is the breaking point.
const STRESS_LEVELS = [100, 200, 400, 600, 800, 1000]; // requests per second
const stress = {};
const stressThresholds = {
  // Safety stop: over 10% errors means the service is down, so stop instead of hammering it.
  http_req_failed: [{ threshold: 'rate<0.10', abortOnFail: true, delayAbortEval: '10s' }],
};
STRESS_LEVELS.forEach((rate, i) => {
  const name = `stress_${rate}`;
  stress[name] = {
    executor: 'constant-arrival-rate',
    rate,
    timeUnit: '1s',
    duration: '1m',
    startTime: `${30 + i * 60}s`,
    preAllocatedVUs: 50,
    maxVUs: 500,
  };
  stressThresholds[`http_req_duration{scenario:${name}}`] = ['p(95)<500'];
  stressThresholds[`http_req_failed{scenario:${name}}`] = ['rate<0.01'];
  stressThresholds[`checks{scenario:${name}}`] = ['rate>0.99'];
  stressThresholds[`dropped_iterations{scenario:${name}}`] = ['count==0'];
});

const PROFILES = {
  smoke: { scenarios: { smoke }, thresholds: { ...loadThresholds, ...smokeAbort } },
  full: { scenarios: { smoke, load }, thresholds: { ...loadThresholds, ...smokeAbort } },
  stress: { scenarios: { smoke, ...stress }, thresholds: { ...stressThresholds, ...smokeAbort } },
};

export const options = PROFILES[PROFILE];

// Runs once before the test starts: print where the load is going.
export function setup() {
  console.log(`Target: ${config.baseUrl}/inbound  (facility ${config.facilityId})`);
}

export default function () {
  // New IDs on every request; LOADTEST- marks the data as load-test data.
  const id = `${Date.now()}-${__VU}-${__ITER}`;
  // Visit dated now, so protocol deadlines are in the future and Step SLA records no misses.
  const start = new Date();
  const end = new Date(start.getTime() + 15 * 60 * 1000);
  const encounter = {
    resourceType: 'Encounter',
    id: `LOADTEST-ENC-${id}`,
    status: 'finished',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
    subject: { reference: `Patient/LOADTEST-${id}` },
    period: { start: start.toISOString(), end: end.toISOString() },
  };

  const res = http.post(`${config.baseUrl}/inbound`, JSON.stringify(encounter), {
    headers: {
      'Content-Type': 'application/json',
      'X-OpenHIM-ClientID': config.clientId,
      'X-Facility-Id': config.facilityId,
    },
  });

  // 202 = forwarded to the collector. 200 means skipped or ignored, so it counts as a failure here.
  // The adaptor's own result is a JSON string inside response.body.
  check(res, {
    'status is 202': (r) => r.status === 202,
    'collector accepted the event': (r) =>
      r.status === 202 && JSON.parse(r.json('response.body')).events[0].collectorStatus === 'accepted',
  });
}
