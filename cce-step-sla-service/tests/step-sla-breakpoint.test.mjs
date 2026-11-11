/**
 * step-sla-breakpoint.test.mjs — the Step SLA breakpoint test definition.
 *
 * What:    Defaults: the storm: STEP_SLA_STORM_ALARMS (100,000) alarms all ringing at once (rate 0).
 *          A Node test definition, not a k6 script: Step SLA is fed by alarms seeded in Postgres. This file
 *          only names the test type; the numbers come from the phase plan (settings, plan §4.1) through
 *          defineStepSlaTest (step-sla-test-definition.mjs). Importing it has no side effect.
 * How:     scripts/run-test.sh local step-sla breakpoint   (or: node tools/cli.mjs run local step-sla breakpoint)
 * Needs:   The shared runner (tools/cli.mjs), which loads it through ../service-module.mjs.
 * Outputs: Default export { testType: 'breakpoint', describe(resolved) → { alarmCount, ratePerSecond,
 *          maxWaitSeconds, catchUpLimitSeconds } }.
 */
import { defineStepSlaTest } from './step-sla-test-definition.mjs';

export default defineStepSlaTest('breakpoint');
