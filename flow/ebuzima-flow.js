// eBUZIMA flow test: patients walk through the eBUZIMA protocol, sending each step's FHIR resource to
// the OpenHIM adaptor, which forwards it to the collector → Kafka → matcher → Step SLA.
// k6 times adaptor + collector (the HTTP reply); flow.sh checks the rest in the database afterwards.
//
// Flow:
//   default    one iteration = one patient: sends that patient's journey (lib/ebuzima.js JOURNEYS)
//              one event after another, in protocol order, as eBUZIMA would
// Patient IDs are LOADTEST-<RUN_ID>-<scenario>-<n>, so flow.sh can find exactly this run's data.
//
// Run it through flow.sh, which sets RUN_ID and does the checks:  ./flow.sh <env> [smoke|full|stress]
// Rates are in patients per second; at 7.3 events per patient:
//   smoke   1 patient/s for 30 s     (~7 events/s)
//   load    7 patients/s for 10 min  (~51 events/s, the expected peak), after the smoke
//   stress  27 patients/s for 10 min (~197 events/s, 4× the peak), after the smoke
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { smokeThresholds } from '../lib/smoke.js';
import { loadThresholds } from '../lib/load.js';
import { stressAbort } from '../lib/stress.js';
import { STEPS, JOURNEYS, EVENTS_PER_PATIENT } from '../lib/ebuzima.js';

if (!__ENV.ENV || !__ENV.RUN_ID) {
  throw new Error('Run through flow.sh, or pass -e ENV=<env> -e RUN_ID=<id>');
}
const config = JSON.parse(open(`../env/${__ENV.ENV}.json`)).openhimAdaptor;

const patients = (rate, duration, startTime, maxVUs) => ({
  executor: 'constant-arrival-rate',
  rate,
  timeUnit: '1s',
  duration,
  startTime,
  preAllocatedVUs: Math.min(rate * 2, maxVUs),
  maxVUs,
});
const SMOKE = patients(1, '30s', '0s', 10);
const PROFILES = {
  smoke: { smoke: SMOKE },
  full: { smoke: SMOKE, load: patients(7, '10m', '30s', 200) },
  stress: { smoke: SMOKE, stress: patients(27, '10m', '30s', 500) },
};
const PROFILE = __ENV.PROFILE || 'smoke';
if (!PROFILES[PROFILE]) {
  throw new Error(`PROFILE must be one of ${Object.keys(PROFILES).join(', ')}, not ${PROFILE}`);
}

// The same pass/fail rules as the single-service tests, plus each step's p95 so the report shows
// whether one resource type is slower than the rest.
const perStep = Object.fromEntries(Object.keys(STEPS).map((s) => [`http_req_duration{step:${s}}`, ['p(95)<500']]));
export const options = {
  scenarios: PROFILES[PROFILE],
  thresholds: { ...loadThresholds, ...smokeThresholds, ...(PROFILE === 'stress' ? stressAbort : {}), ...perStep },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export function setup() {
  console.log(`Target: ${config.baseUrl}/inbound  run ${__ENV.RUN_ID}  profile ${PROFILE}  (${EVENTS_PER_PATIENT} events per patient)`);
}

export default function () {
  const n = exec.scenario.iterationInTest;
  const patient = `LOADTEST-${__ENV.RUN_ID}-${exec.scenario.name}-${n}`;

  for (const step of JOURNEYS[n % JOURNEYS.length]) {
    const resource = STEPS[step]({ id: `${patient}-${step}`, patient, facility: config.facilityId, time: new Date().toISOString() });
    const res = http.post(`${config.baseUrl}/inbound`, JSON.stringify(resource), {
      headers: {
        'Content-Type': 'application/json',
        'X-OpenHIM-ClientID': config.clientId,
        'X-Facility-Id': config.facilityId,
        // eBUZIMA's own event ID: the adaptor derives the CloudEvent id from it (UUID v5).
        'X-Source-Event-Id': `${patient}-${step}`,
      },
      tags: { step },
    });

    // 202 = forwarded and the collector accepted it. The adaptor's own result is a JSON string
    // inside response.body.
    check(res, {
      'status is 202': (r) => r.status === 202,
      'collector accepted the event': (r) =>
        r.status === 202 && JSON.parse(r.json('response.body')).events[0].collectorStatus === 'accepted',
    }, { step });
  }
}
