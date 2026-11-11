/**
 * step-sla-data-checks.mjs — the Step SLA verdict, from the database: how long each seeded alarm waited.
 *
 * What:    The live counters are global and sampled every few seconds; the database knows each alarm exactly.
 *          For every alarm of this run it reads when it rang (process_by) and when Step SLA handled it
 *          (processed_at); the difference is the wait a patient's record "feels" (v1 decision D8). Checks:
 *            step-sla.alarms-seeded   the run's DUE alarms are all in the database (= alarm count)
 *            step-sla.all-handled     every alarm handled (is_processed)
 *            step-sla.all-overdue     every step judged OVERDUE (none of them was done in time)
 *            step-sla.deviations      one OVERDUE deviation per step
 *            step-sla.max-wait        smoke/load/stress: longest wait < STEP_SLA_MAX_WAIT (2 poll intervals)
 *            step-sla.storm-catch-up  breakpoint: last alarm handled < STEP_SLA_STORM_MAX_CATCH_UP after the ring
 *            step-sla.wait-avg / step-sla.wait-p95 (info), step-sla.storm-drain (info, breakpoint)
 *          "Started breaking" = the ring time (process_by) of the first alarm that waited longer than the limit
 *          (or is still waiting past it); it travels in the `details` of the max-wait / storm check.
 *          Ported from the first version's report-sla.sh (same SQL idea) with the run selector LOADTEST-<runId>-sla-,
 *          the UUIDv7 floor on protocol_instance.id (index-friendly, plan §6.8) and a statement timeout;
 *          JSON in and out, no text parsing.
 * How:     const checks = await runStepSlaDataChecks(ctx, { plan });   (the service module's dataChecks)
 *          Re-run later: node tools/cli.mjs check-data <env> <resultDir>
 * Needs:   ctx.pgPool, ctx.selector, ctx.context.startedAt (run start), ctx.phasePlan; plan from describe().
 * Outputs: DataCheck[] { id, description, expected, actual, comparison, passed, severity, sql?, durationMs?, details? }.
 */
import { DEFAULT_STATEMENT_TIMEOUT_MS, runTimedQuery, uuidV7LowerBound } from '../shared.mjs';

/**
 * One query, one row: every number the checks need (parameters: $1 UUIDv7 floor, $2 LIKE pattern,
 * $3 max wait in seconds). protocol_instance is reached through its primary key range first
 * (id >= floor: ids are time-ordered UUIDv7), then the patient prefix.
 */
export const ALARMS_SQL = `WITH alarm AS (
  SELECT t.is_processed, t.process_by, t.processed_at, s.sla_status, s.id AS step_id,
         extract(epoch FROM t.processed_at - t.process_by) AS wait
  FROM protocol_instance p
  JOIN step_instance s ON s.protocol_instance_id = p.id
  JOIN step_sla_state_transition t ON t.step_instance_id = s.id AND t.transition_type = 'DUE_DATE_REACHED'
  WHERE p.id >= $1::uuid AND p.patient_id LIKE $2
)
SELECT count(*)::int AS seeded,
       count(*) FILTER (WHERE is_processed)::int AS handled,
       count(*) FILTER (WHERE sla_status = 'OVERDUE')::int AS overdue,
       (SELECT count(*)::int FROM deviation d
         WHERE d.deviation_type = 'OVERDUE' AND d.step_instance_id IN (SELECT step_id FROM alarm)) AS deviations,
       avg(wait)::float8 AS wait_avg,
       (percentile_cont(0.95) WITHIN GROUP (ORDER BY wait))::float8 AS wait_p95,
       max(wait)::float8 AS wait_max,
       min(process_by) AS first_ring,
       max(process_by) AS last_ring,
       max(processed_at) AS last_handled,
       count(*) FILTER (WHERE wait > $3::float8
                         OR (NOT is_processed AND process_by + make_interval(secs => $3::float8) < now()))::int
         AS over_limit,
       min(process_by) FILTER (WHERE wait > $3::float8
                                OR (NOT is_processed AND process_by + make_interval(secs => $3::float8) < now()))
         AS started_breaking_at
FROM alarm`;

/** Number or null, rounded to milliseconds; why: pg floats carry noise like 69.80000000001. */
function num(value) {
  if (value === null || value === undefined) return null;
  return Math.round(Number(value) * 1000) / 1000;
}

/** ISO text of a pg timestamp (Date) or null. */
function iso(value) {
  if (value === null || value === undefined) return null;
  return new Date(value).toISOString();
}

/**
 * The query and its parameters for one run.
 * Why: pure, so the unit tests check the selector and the floor without a database.
 * @param {{selector:string, runStart:string|Date, maxWaitSeconds:number}} input
 * @returns {{sql:string, params:unknown[]}}
 */
export function buildAlarmQuery({ selector, runStart, maxWaitSeconds }) {
  // run start − 5 min: the seeded ids are generated after the run started, so none is below this floor.
  return { sql: ALARMS_SQL, params: [uuidV7LowerBound(runStart), `${selector}%`, maxWaitSeconds] };
}

/**
 * Turns the query row into DataCheck objects.
 * Why: pure — the PASS/FAIL logic is unit-tested with v1's real numbers.
 * @param {{row:object, plan:{alarmCount:number, maxWaitSeconds:number}, testType:string, sql?:string, durationMs?:number}} input
 * @returns {object[]} DataCheck[]
 */
export function judgeAlarmRow({ row, plan, testType, sql = null, durationMs = null }) {
  const count = plan.alarmCount;
  const storm = testType === 'breakpoint';
  const seeded = num(row.seeded) ?? 0;
  const handled = num(row.handled) ?? 0;
  const firstRing = iso(row.first_ring);
  const lastRing = iso(row.last_ring);
  const lastHandled = iso(row.last_handled);
  const waitMax = num(row.wait_max);
  // The SQL text is kept once (on the first check) for transparency; the timing on every check.
  const shared = { durationMs };
  const equals = (id, description, actual) => ({
    id,
    description,
    expected: count,
    actual,
    comparison: 'equals',
    passed: actual === count,
    severity: 'required',
    ...shared,
  });
  const details = {
    startedBreakingAt: iso(row.started_breaking_at),
    alarmsOverLimit: num(row.over_limit) ?? 0,
    limitSeconds: plan.maxWaitSeconds,
    firstRing,
    lastRing,
    lastHandled,
    handled,
    seeded,
    waitAvgSeconds: num(row.wait_avg),
    waitP95Seconds: num(row.wait_p95),
    waitMaxSeconds: waitMax,
  };
  const checks = [
    {
      ...equals(
        'step-sla.alarms-seeded',
        'Every seeded alarm of this run is in the database',
        seeded,
      ),
      sql,
    },
    equals('step-sla.all-handled', 'Every seeded alarm handled by Step SLA', handled),
    equals('step-sla.all-overdue', 'Every seeded step judged OVERDUE', num(row.overdue) ?? 0),
    equals(
      'step-sla.deviations',
      'One OVERDUE deviation per seeded step',
      num(row.deviations) ?? 0,
    ),
  ];
  if (storm) {
    // Storm: everything rang at once, so the catch-up is the time from the ring to the last alarm handled.
    const catchUp =
      lastHandled && lastRing ? num((Date.parse(lastHandled) - Date.parse(lastRing)) / 1000) : null;
    const allHandled = handled === count && count > 0;
    checks.push({
      id: 'step-sla.storm-catch-up',
      description: `Storm: every alarm handled within ${plan.maxWaitSeconds} s of ringing (STEP_SLA_STORM_MAX_CATCH_UP)`,
      expected: plan.maxWaitSeconds,
      // Not all handled → no catch-up time at all (never the time of the last one handled so far, D19).
      actual: allHandled ? catchUp : null,
      comparison: 'at-most',
      passed: allHandled && catchUp !== null && catchUp < plan.maxWaitSeconds,
      severity: 'required',
      ...shared,
      details: { ...details, catchUpSeconds: allHandled ? catchUp : null },
    });
    const drain = allHandled && catchUp > 0 ? Math.round((handled / catchUp) * 10) / 10 : null;
    checks.push({
      id: 'step-sla.storm-drain',
      description: 'Storm: average alarms handled per second from the ring to the last one (info)',
      expected: null,
      actual: drain,
      comparison: 'at-least',
      passed: true,
      severity: 'info',
      ...shared,
    });
  } else {
    checks.push({
      id: 'step-sla.max-wait',
      description: `Longest wait after an alarm rang under ${plan.maxWaitSeconds} s (STEP_SLA_MAX_WAIT, 2 poll intervals)`,
      expected: plan.maxWaitSeconds,
      actual: waitMax,
      comparison: 'at-most',
      // Strictly under the limit, as v1; unhandled alarms have no wait and fail all-handled instead.
      passed: waitMax !== null && waitMax < plan.maxWaitSeconds && details.alarmsOverLimit === 0,
      severity: 'required',
      ...shared,
      details,
    });
  }
  checks.push(
    {
      id: 'step-sla.wait-avg',
      description: 'Average wait after ringing, seconds (info)',
      expected: null,
      actual: num(row.wait_avg),
      comparison: 'at-most',
      passed: true,
      severity: 'info',
      ...shared,
    },
    {
      id: 'step-sla.wait-p95',
      description: '95th percentile wait after ringing, seconds (info)',
      expected: null,
      actual: num(row.wait_p95),
      comparison: 'at-most',
      passed: true,
      severity: 'info',
      ...shared,
    },
  );
  return checks;
}

/**
 * Runs the Step SLA data checks of one run.
 * Why: the service module's dataChecks hook; also what `check-data` re-runs from run-context.json.
 * @param {object} ctx run ctx (plan §6.4) or the check-data ctx
 * @param {{plan:{alarmCount:number, maxWaitSeconds:number}, timeoutMs?:number}} options
 * @returns {Promise<object[]>} DataCheck[]
 */
export async function runStepSlaDataChecks(
  ctx,
  { plan, timeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS },
) {
  const testType = ctx.phasePlan?.testType ?? ctx.context?.testType;
  const runStart = ctx.context?.startedAt;
  if (!runStart)
    throw new Error('Step SLA data checks need the run start (run-context.json startedAt)');
  const { sql, params } = buildAlarmQuery({
    selector: ctx.selector,
    runStart,
    maxWaitSeconds: plan.maxWaitSeconds,
  });
  const { rows, durationMs } = await runTimedQuery(ctx.pgPool, { sql, params, timeoutMs });
  return judgeAlarmRow({ row: rows[0] ?? {}, plan, testType, sql, durationMs });
}
