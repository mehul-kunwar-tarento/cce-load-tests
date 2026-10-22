// Load test for the collector on its own: POST /v1/events with the CloudEvent the OpenHIM adaptor sends.
// Run: ./run.sh local collector/collector.js                    (smoke, then load)
//      ./run.sh local collector/collector.js -e PROFILE=smoke   (smoke only)
//      ./run.sh local collector/collector.js -e PROFILE=stress  (smoke, then a staircase to find the breaking point)
import http from 'k6/http';
import { check } from 'k6';
import { optionsFor } from '../lib/options.js';

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
  // New IDs on every request; LOADTEST- marks the data as load-test data.
  const id = `${Date.now()}-${__VU}-${__ITER}`;
  // Visit dated now, so protocol deadlines are in the future and Step SLA records no misses.
  const start = new Date();
  const end = new Date(start.getTime() + 15 * 60 * 1000);

  // The same envelope the OpenHIM adaptor builds. The collector treats a repeated id + source as a
  // duplicate and skips the database write and Kafka publish, so the id must be new every time.
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

  const res = http.post(`${config.baseUrl}/v1/events`, JSON.stringify(event), {
    headers: { 'Content-Type': 'application/json' },
  });

  // 202 + "accepted" = stored and published to Kafka. 200 "duplicate" counts as a failure here.
  check(res, {
    'status is 202': (r) => r.status === 202,
    'event accepted': (r) => r.status === 202 && r.json('data.status') === 'accepted',
  });
}
