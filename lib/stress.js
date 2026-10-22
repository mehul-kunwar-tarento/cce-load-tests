// Stress: one step per level, 1 minute each, one after another after the 30-second smoke.
// Each step is its own scenario (stress_100, stress_200, ...), so the summary shows pass/fail per level
// with the same rules as the load run. The first level that fails is the breaking point.
const STRESS_LEVELS = [100, 200, 400, 600, 800, 1000]; // requests per second

export const stressScenarios = {};
export const stressThresholds = {
  // Safety stop: over 10% errors means the service is down, so stop instead of hammering it.
  http_req_failed: [{ threshold: 'rate<0.10', abortOnFail: true, delayAbortEval: '10s' }],
};

STRESS_LEVELS.forEach((rate, i) => {
  const name = `stress_${rate}`;
  stressScenarios[name] = {
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
