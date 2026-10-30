// Stress: find the breaking point as traffic grows (test plan D2, D14). Right after the 30-second smoke
// the rate climbs in steps, 1 minute each. Each step is its own scenario (step_100, step_150, ...), so a
// test can judge every step on its own: the first step it can't keep up with is the breaking point.
//
// Change the steps here; nothing else needs to change.
export const STRESS_STEPS = [100, 150, 200, 250, 300, 350, 400]; // events per second
export const STEP_SECONDS = 60;

export const stressScenarios = {};
for (let i = 0; i < STRESS_STEPS.length; i++) {
  const rate = STRESS_STEPS[i];
  const startsAt = 30 + i * STEP_SECONDS; // after the smoke, one step after the other

  stressScenarios[`step_${rate}`] = {
    executor: 'constant-arrival-rate',
    rate: rate,
    timeUnit: '1s',
    duration: `${STEP_SECONDS}s`,
    startTime: `${startsAt}s`,
    preAllocatedVUs: 10, // one Kafka write takes well under a millisecond, so few are needed
    maxVUs: 100,
  };
}
