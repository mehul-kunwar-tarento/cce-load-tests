/**
 * step-sla-load.test.mjs — the Step SLA load test definition.
 *
 * What:    Defaults: 30,000 alarms ringing 50/s for 10 min (LOAD_RATE × LOAD_DURATION): the steady alarm rate.
 *          A Node test definition, not a k6 script: Step SLA is fed by alarms seeded in Postgres. This file
 *          only names the test type; the numbers come from the phase plan (settings, plan §4.1) through
 *          defineStepSlaTest (step-sla-test-definition.mjs). Importing it has no side effect.
 * How:     scripts/run-test.sh local step-sla load   (or: node tools/cli.mjs run local step-sla load)
 * Needs:   The shared runner (tools/cli.mjs), which loads it through ../service-module.mjs.
 * Outputs: Default export { testType: 'load', describe(resolved) → { alarmCount, ratePerSecond,
 *          maxWaitSeconds, catchUpLimitSeconds } }.
 */
import { defineStepSlaTest } from './step-sla-test-definition.mjs';

export default defineStepSlaTest('load');
