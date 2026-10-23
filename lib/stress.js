// Stress: 4× the expected peak, 200 requests per second for 10 minutes, after the 30-second smoke.
// Passing it means the service handled 120,000 events in 10 minutes with the same rules as the load run.
// We don't hunt for the breaking point: 4× peak leaves room for growth and for catch-up after an outage.
export const stressScenario = {
  executor: 'constant-arrival-rate',
  rate: 200,
  timeUnit: '1s',
  duration: '10m',
  startTime: '30s',
  preAllocatedVUs: 100,
  maxVUs: 500,
};

// Safety stop: over 10% errors means the service is down, so stop instead of hammering it.
export const stressAbort = {
  'http_req_failed{scenario:stress}': [{ threshold: 'rate<0.10', abortOnFail: true, delayAbortEval: '10s' }],
};
