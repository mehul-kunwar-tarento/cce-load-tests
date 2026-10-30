// Load test for the OpenHIM emitter adaptor (eBUZIMA → adaptor → collector), one eBUZIMA visit
// Encounter per request. For the whole flow through the matcher and Step SLA, use flow.sh.
// Run: ./run.sh local adaptor/openhim.js                    (smoke, then load)
//      ./run.sh local adaptor/openhim.js -e PROFILE=smoke   (smoke only)
//      ./run.sh local adaptor/openhim.js -e PROFILE=stress  (smoke, then a staircase to find the breaking point)
import http from 'k6/http';
import { check } from 'k6';
import { optionsFor } from '../lib/options.js';
import { visitEncounter } from '../lib/ebuzima.js';

if (!__ENV.ENV) {
  throw new Error('Choose an environment, e.g. -e ENV=local');
}
const config = JSON.parse(open(`../env/${__ENV.ENV}.json`)).openhimAdaptor;

export const options = optionsFor(__ENV.PROFILE || 'full');

// Runs once before the test starts: print where the load is going.
export function setup() {
  console.log(`Target: ${config.baseUrl}/inbound  (facility ${config.facilityId})`);
}

export default function () {
  // A new patient on every request; LOADTEST- marks the data as load-test data. Dated now, so the
  // protocol's deadlines are in the future and Step SLA records no misses.
  const patient = `LOADTEST-${Date.now()}-${__VU}-${__ITER}`;
  const encounter = visitEncounter(patient, config.facilityId);

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
