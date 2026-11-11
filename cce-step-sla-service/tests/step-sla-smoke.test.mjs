/**
 * step-sla-smoke.test.mjs — the Step SLA smoke test definition.
 *
 * What:    Defaults: 30 alarms ringing 1/s for 30 s (SMOKE_RATE × SMOKE_DURATION): proves seeding, watcher and checks.
 *          A Node test definition, not a k6 script: Step SLA is fed by alarms seeded in Postgres. This file
 *          only names the test type; the numbers come from the phase plan (settings, plan §4.1) through
 *          defineStepSlaTest (step-sla-test-definition.mjs). Importing it has no side effect.
 * How:     scripts/run-test.sh local step-sla smoke   (or: node tools/cli.mjs run local step-sla smoke)
 * Needs:   The shared runner (tools/cli.mjs), which loads it through ../service-module.mjs.
 * Outputs: Default export { testType: 'smoke', describe(resolved) → { alarmCount, ratePerSecond,
 *          maxWaitSeconds, catchUpLimitSeconds } }.
 */
import { defineStepSlaTest } from './step-sla-test-definition.mjs';

export default defineStepSlaTest('smoke');
