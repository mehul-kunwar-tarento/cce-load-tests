// Smoke: 1 request per second for 30 seconds, to prove the script and setup work.
export const smokeScenario = {
  executor: 'constant-arrival-rate',
  rate: 1,
  timeUnit: '1s',
  duration: '30s',
  preAllocatedVUs: 2,
};

// If the smoke fails, stop at once instead of sending thousands of bad requests.
export const smokeThresholds = {
  'checks{scenario:smoke}': [{ threshold: 'rate>0.99', abortOnFail: true }],
};
