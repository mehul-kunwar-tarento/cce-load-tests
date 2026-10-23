// Load: the expected peak, 50 requests per second for 10 minutes, starting right after the 30-second smoke.
// (600,000 events a day = about 7/s on average and 50/s in 10-minute peaks: cce-data-pipeline docs §7.1.)
export const loadScenario = {
  executor: 'constant-arrival-rate',
  rate: 50,
  timeUnit: '1s',
  duration: '10m',
  startTime: '30s',
  preAllocatedVUs: 50, // virtual users ready at the start
  maxVUs: 200,         // k6 may add more if the service slows down, up to this
};

// Pass/fail rules, used by both the load and the stress run.
export const loadThresholds = {
  http_req_duration: ['p(95)<500'], // 95% of requests answered within 500 ms
  http_req_failed: ['rate<0.01'],   // under 1% of requests get a 4xx/5xx
  checks: ['rate>0.99'],            // over 99% pass the test's checks (catches e.g. "200 skipped")
  dropped_iterations: ['count==0'], // k6 always managed to send at the set rate
};
