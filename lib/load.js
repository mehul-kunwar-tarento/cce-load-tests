// Load: 100 requests per second for 5 minutes, starting right after the 30-second smoke.
export const loadScenario = {
  executor: 'constant-arrival-rate',
  rate: 100,
  timeUnit: '1s',
  duration: '5m',
  startTime: '30s',
  preAllocatedVUs: 50, // virtual users ready at the start
  maxVUs: 200,         // k6 may add more if the service slows down, up to this
};

// Pass/fail rules for the load run.
export const loadThresholds = {
  http_req_duration: ['p(95)<500'], // 95% of requests answered within 500 ms
  http_req_failed: ['rate<0.01'],   // under 1% of requests get a 4xx/5xx
  checks: ['rate>0.99'],            // over 99% pass the test's checks (catches e.g. "200 skipped")
  dropped_iterations: ['count==0'], // k6 always managed to send at the set rate
};
