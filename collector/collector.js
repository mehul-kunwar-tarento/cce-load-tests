// Load test for the collector on its own: POST /v1/events with the CloudEvent the OpenHIM adaptor sends.
// Run: ./run.sh local collector/collector.js                    (smoke, then load)
//      ./run.sh local collector/collector.js -e PROFILE=smoke   (smoke only)
//      ./run.sh local collector/collector.js -e PROFILE=stress  (smoke, then a staircase to find the breaking point)
import http from 'k6/http';
import { check } from 'k6';
import { optionsFor } from '../lib/options.js';
import { visitEncounter } from '../lib/ebuzima.js';

if (!__ENV.ENV) {
  throw new Error('Choose an environment, e.g. -e ENV=local');
}
const config = JSON.parse(open(`../env/${__ENV.ENV}.json`)).collector;

export const options = optionsFor(__ENV.PROFILE || 'full');

// Runs once before the test starts: print where the load is going.
export function setup() {
  console.log(`Target: ${config.baseUrl}/v1/events  (facility ${config.facilityId})`);
}

export default function () {
  // A new patient on every request; LOADTEST- marks the data as load-test data. Dated now, so the
  // protocol's deadlines are in the future and Step SLA records no misses.
  const patient = `LOADTEST-${Date.now()}-${__VU}-${__ITER}`;
  const encounter = visitEncounter(patient, config.facilityId);

  // The same envelope the OpenHIM adaptor builds. The collector treats a repeated id + source as a
  // duplicate and skips the database write and Kafka publish, so the id must be new every time.
  const event = {
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: 'ebuzima',
    type: 'Encounter',
    subject: patient,
    time: encounter.period.start,
    facilityid: config.facilityId,
    datacontenttype: 'application/fhir+json',
    data: encounter,
  };

  const res = http.post(`${config.baseUrl}/v1/events`, JSON.stringify(event), {
    headers: { 'Content-Type': 'application/json' },
  });

  // 202 + "accepted" = stored and published to Kafka. 200 "duplicate" counts as a failure here.
  check(res, {
    'status is 202': (r) => r.status === 202,
    'event accepted': (r) => r.status === 202 && r.json('data.status') === 'accepted',
  });
}
