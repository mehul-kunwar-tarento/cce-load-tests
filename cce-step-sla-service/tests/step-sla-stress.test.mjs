/**
 * step-sla-stress.test.mjs — the Step SLA stress test definition.
 *
 * What:    Defaults: 120,000 alarms ringing 200/s for 10 min (STRESS_RATE × STRESS_DURATION): 4 × the load rate.
 *          A Node test definition, not a k6 script: Step SLA is fed by alarms seeded in Postgres. This file
 *          only names the test type; the numbers come from the phase plan (settings, plan §4.1) through
 *          defineStepSlaTest (step-sla-test-definition.mjs). Importing it has no side effect.
 * How:     scripts/run-test.sh local step-sla stress   (or: node tools/cli.mjs run local step-sla stress)
 * Needs:   The shared runner (tools/cli.mjs), which loads it through ../service-module.mjs.
 * Outputs: Default export { testType: 'stress', describe(resolved) → { alarmCount, ratePerSecond,
 *          maxWaitSeconds, catchUpLimitSeconds } }.
 */
import { defineStepSlaTest } from './step-sla-test-definition.mjs';

export default defineStepSlaTest('stress');
