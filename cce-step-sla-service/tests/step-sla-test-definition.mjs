/**
 * step-sla-test-definition.mjs — what one Step SLA test type means: how many alarms, how fast, which limits.
 *
 * What:    Step SLA has no k6 script: its "load" is alarms seeded in Postgres that ring at chosen times.
 *          A test definition therefore only DESCRIBES the run: how many alarms (alarmCount), how many ring per
 *          second (ratePerSecond; 0 = all at once for the storm), the longest acceptable wait after an alarm
 *          rings (maxWaitSeconds) and how long the watcher waits after the last ring (catchUpLimitSeconds).
 *          The alarm count and rate are read from the phase plan — the single source shared with the
 *          settings printout, the report and the result (plan §4.1, §6.7) — never recomputed here.
 * How:     export default defineStepSlaTest('load');   (in tests/step-sla-load.test.mjs)
 *          const plan = definition.describe(resolvedSettings);
 * Needs:   ResolvedSettings from tools/core/settings.mjs with derived.phasePlan (breakpoint kind 'none').
 * Outputs: { testType, describe(resolved) → { alarmCount, ratePerSecond, maxWaitSeconds, catchUpLimitSeconds } }.
 *          Importing this file has no side effect.
 */

/** The four test types Step SLA supports; the breakpoint is the "storm" (all alarms ring at once). */
export const STEP_SLA_TEST_TYPES = Object.freeze(['smoke', 'load', 'stress', 'breakpoint']);

/**
 * Builds the definition of one test type.
 * Why: the four test files differ only in their type, so the logic lives once, here.
 * @param {'smoke'|'load'|'stress'|'breakpoint'} testType
 * @returns {{testType:string, describe(resolved:object): {alarmCount:number, ratePerSecond:number,
 *            maxWaitSeconds:number, catchUpLimitSeconds:number}}}
 */
export function defineStepSlaTest(testType) {
  if (!STEP_SLA_TEST_TYPES.includes(testType)) {
    throw new Error(`Unknown Step SLA test type "${testType}"`);
  }
  return Object.freeze({
    testType,
    /**
     * Describes the run from the resolved settings.
     * Why: seeding, the watcher and the data checks must agree on the numbers; they all call this.
     * @param {{values:Record<string, any>, derived:{phasePlan:object|null}}} resolved
     */
    describe(resolved) {
      const phasePlan = resolved?.derived?.phasePlan;
      if (!phasePlan) {
        throw new Error(
          'Step SLA test needs the phase plan (resolve settings with subject, test type, breakpoint kind)',
        );
      }
      // A plan built for another test type or a k6 service would seed the wrong numbers: refuse.
      if (phasePlan.testType !== testType || phasePlan.breakpointKind !== 'none') {
        throw new Error(
          `Phase plan is for ${phasePlan.testType}/${phasePlan.breakpointKind}, not step-sla ${testType}/none`,
        );
      }
      const measured = phasePlan.phases.find((phase) => phase.name === phasePlan.measuredPhase);
      const values = resolved.values ?? {};
      const storm = testType === 'breakpoint';
      // Storm: every alarm rings at the same moment, so "longest wait" = time to drain them all.
      const maxWaitSeconds = storm ? values.STEP_SLA_STORM_MAX_CATCH_UP : values.STEP_SLA_MAX_WAIT;
      if (typeof maxWaitSeconds !== 'number') {
        throw new Error(
          'STEP_SLA_MAX_WAIT could not be resolved (auto needs services.stepSla.pollIntervalSeconds in the ' +
            'environment file): set it, e.g. --set STEP_SLA_MAX_WAIT=10s',
        );
      }
      return {
        // plannedMeasuredEvents: the alarm count (Step SLA phase plans have only the measured phase).
        alarmCount: phasePlan.plannedMeasuredEvents,
        ratePerSecond: measured.rate,
        maxWaitSeconds,
        catchUpLimitSeconds: storm ? values.BREAKPOINT_CATCH_UP_LIMIT : values.CATCH_UP_LIMIT,
      };
    },
  });
}
