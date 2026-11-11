/**
 * matcher-data-checks.mjs — proves from the database that the matcher handled every event of the run.
 *
 * What:    Speed means nothing if events were lost or matched wrongly. After a matcher test these checks
 *          compare what was sent with what the database holds (plan §6.8):
 *            matcher.logged-equals-sent       matcher_event_log rows of the run = events k6 wrote to Kafka
 *            matcher.all-matched              every logged event has processing_status MATCHED
 *            matcher.patients-enrolled        distinct patients in protocol_instance = events (one new patient each)
 *            matcher.enrolments-equal-fan-out protocol_instance rows = effectiveFanOut × enrolled patients
 *                                             (effectiveFanOut = plan definitions of the set + other ACTIVE ones
 *                                             that also match the test events)
 *            matcher.steps-created            step_instance rows = expected rows per event × events (info until a
 *                                             live smoke confirms the rule)
 *            matcher.no-dead-letters          no new records on the dead-letter topic (measured by the watcher)
 *          Rows are selected index-friendly: event ids are generated from the phase plan, plus 1 % + 10 per
 *          phase for the iteration or two k6 may start more at a phase edge (candidatePhasePlan, the same rule
 *          as cleanup), and joined on the unique (cloudevents_id, source) index; protocol/step instances are
 *          bounded by the UUIDv7 floor of the run start before the patient-id selector is applied. Every
 *          query has a statement_timeout.
 * How:     Called by the runner through service-module.mjs (`dataChecks(ctx)`), and again by
 *          `node tools/cli.mjs check-data <env> <resultDir>`. Unit tests inject a fake pg pool.
 * Needs:   ctx.pgPool (DB_PASSWORD set), ctx.selector (LOADTEST-<runId>-mat-), ctx.phasePlan, ctx.context
 *          (startedAt), ctx.settings (EVENT_SOURCE), ctx.planDefinitionSet (effectiveFanOut, expectedRows),
 *          ctx.kafkaAdmin (lag at check time), results files k6-summary.json and watch-backlog.json.
 * Outputs: DataCheck[] = { id, description, expected, actual, comparison, passed, severity, sql, durationMs }.
 */
import path from 'node:path';
import {
  DEFAULT_STATEMENT_TIMEOUT_MS,
  candidateEventIdsSql,
  candidatePhasePlan,
  computeExpectedRows,
  formatNumber,
  metricValue,
  normaliseK6Summary,
  readJsonIfExists,
  runTimedQuery,
  uuidV7LowerBound,
} from '../shared.mjs';

/**
 * SQL counting the run's matcher_event_log rows by status ($1 = event source).
 * Why: joins the generated candidate ids on the unique (cloudevents_id, source) index instead of a LIKE scan.
 * Pass candidatePhasePlan(phasePlan) (with the 1 % + 10 margin), not the raw plan: the k6 edge iterations
 * must be among the candidates (runMatcherDataChecks does this).
 * @param {{selector:string, phasePlan:object}} input
 * @returns {string}
 */
export function buildEventCountsSql({ selector, phasePlan }) {
  return `WITH candidates AS (
${candidateEventIdsSql({ selector, phasePlan })}
)
SELECT count(*)::bigint AS logged,
       count(*) FILTER (WHERE m.processing_status = 'MATCHED')::bigint AS matched,
       count(*) FILTER (WHERE m.processing_status = 'ZERO_MATCH')::bigint AS zero_match,
       count(*) FILTER (WHERE m.processing_status = 'DUPLICATE')::bigint AS duplicate
FROM matcher_event_log m
JOIN candidates c ON m.cloudevents_id = c.id
WHERE m.source = $1`;
}

/**
 * SQL counting enrolments and distinct patients of the run ($1 = UUIDv7 floor, $2 = selector).
 * Why: protocol_instance ids are time-ordered UUIDv7, so `id >= floor` skips older rows through the
 * primary key before the (unindexable) LIKE is applied (plan §2.3, §6.8).
 * @returns {string}
 */
export function buildEnrolmentCountsSql() {
  return `SELECT count(*)::bigint AS enrolments,
       count(DISTINCT pi.patient_id)::bigint AS patients
FROM protocol_instance pi
WHERE pi.id >= $1::uuid
  AND pi.patient_id LIKE $2 || '%'`;
}

/**
 * SQL counting the step instances created for the run's enrolments ($1 = UUIDv7 floor, $2 = selector).
 * Why: step_instance ids are UUIDv7 too, so both tables are bounded by the floor.
 * @returns {string}
 */
export function buildStepCountsSql() {
  return `SELECT count(*)::bigint AS steps
FROM step_instance s
JOIN protocol_instance pi ON s.protocol_instance_id = pi.id
WHERE pi.id >= $1::uuid
  AND s.id >= $1::uuid
  AND pi.patient_id LIKE $2 || '%'`;
}

/**
 * Events k6 handed to Kafka: kafka_writer_message_count, else events_accepted, else events_sent.
 * Why: plan §6.8 — the matcher must have logged exactly what was written into the topic.
 * @param {object|null} k6Summary raw k6-summary.json
 * @returns {{value:number|null, source:string|null}}
 */
export function sentFromSummary(k6Summary) {
  if (!k6Summary) return { value: null, source: null };
  const normalised = normaliseK6Summary(k6Summary);
  for (const key of ['kafka_writer_message_count', 'events_accepted', 'events_sent']) {
    const value = metricValue(normalised, key, 'count');
    if (value !== null) return { value, source: key };
  }
  return { value: null, source: null };
}

/** Number of a bigint column (pg returns bigint as text); why: comparisons need numbers. */
function toNumber(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Decides `passed` for one comparison; why: one place for equals / at-least / at-most / between. */
function compare(actual, expected, comparison) {
  if (typeof actual !== 'number' || expected === null || expected === undefined) return false;
  if (comparison === 'equals') return actual === expected;
  if (comparison === 'at-least') return actual >= expected;
  if (comparison === 'at-most') return actual <= expected;
  if (comparison === 'between') return actual >= expected[0] && actual <= expected[1];
  return false;
}

/** Builds one DataCheck; why: every check has the same shape (plan §6.8) and the same pass rule. */
function check({
  id,
  description,
  expected,
  actual,
  comparison = 'equals',
  severity,
  sql,
  durationMs,
}) {
  return {
    id,
    description,
    expected,
    actual,
    comparison,
    passed: compare(actual, expected, comparison),
    severity,
    ...(sql ? { sql } : {}),
    ...(typeof durationMs === 'number' ? { durationMs } : {}),
  };
}

/**
 * Is the matcher still working through this run's events right now?
 * Why: when a stress run did not catch up, counts taken now are partial; such checks become `info`
 * (re-run `check-data` later) instead of failing on "not yet".
 * @returns {Promise<boolean|null>} null when unknown
 */
async function isStillDraining(ctx, watchOutcome) {
  const kafka = ctx.environment?.kafka ?? {};
  if (ctx.kafkaAdmin) {
    try {
      const lag = await ctx.kafkaAdmin.getGroupLag({
        groupId: kafka.matcherConsumerGroup,
        topic: kafka.inboundTopic,
      });
      if (typeof lag?.total === 'number') return lag.total > 0;
    } catch (error) {
      ctx.logger?.warn?.(`data checks: consumer lag not readable (${error.message})`);
    }
  }
  // Fall back to the watcher's verdict when Kafka cannot be asked.
  if (watchOutcome?.breaking?.caughtUp === false) return true;
  return watchOutcome ? false : null;
}

/**
 * Expected rows per event of the set (plan §7.3); from ctx when the runner computed them, else here.
 * Why: check-data and older runs may carry the set without expectedRows.
 */
function expectedRowsOf(ctx) {
  const set = ctx.planDefinitionSet ?? {};
  if (set.expectedRows) return set.expectedRows;
  // Empty setting = the dataset's default action (same rule as the settings resolver).
  const actionId = ctx.settings?.EVENT_ACTION_ID || ctx.context?.dataset?.defaultActionId || null;
  if (!set.planDefinitions?.some((pd) => pd.json) || !actionId) return null;
  try {
    return computeExpectedRows(set, actionId);
  } catch (error) {
    ctx.logger?.warn?.(`data checks: expected rows unknown (${error.message})`);
    return null;
  }
}

/**
 * Runs every matcher data check (plan §6.8).
 * @param {object} ctx run ctx (plan §6.4) or the ctx `check-data` rebuilds
 * @param {{readResultFile?:(name:string) => object|null, timeoutMs?:number}} [deps] fakes for tests
 * @returns {Promise<object[]>} DataCheck[]
 */
export async function runMatcherDataChecks(ctx, deps = {}) {
  const {
    readResultFile = (name) => readJsonIfExists(path.join(ctx.resultsDir, name)),
    timeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS,
  } = deps;
  if (!ctx.pgPool) {
    throw new Error(
      'no database connection: set DB_PASSWORD (the matcher data checks need Postgres)',
    );
  }
  // `||`, not `??`: an empty setting means "use the dataset's source" (older run contexts may hold '').
  const source = ctx.settings.EVENT_SOURCE || ctx.context?.dataset?.source;
  const k6Summary = readResultFile('k6-summary.json');
  const watchFile = readResultFile('watch-backlog.json');
  const watchOutcome = watchFile?.outcome ?? null;
  const sent = sentFromSummary(k6Summary);
  const draining = await isStillDraining(ctx, watchOutcome);
  // Checks that only hold once the matcher has caught up are info while it is still draining.
  const untilDrained = draining ? 'info' : 'required';
  const drainingNote = draining
    ? ' (matcher still draining when checked: re-run `check-data` once it is idle)'
    : '';
  const checks = [];

  // 1. Events: logged and matched.
  // The candidate ids get the 1 % + 10 margin per phase (same rule as the collector checks and cleanup):
  // at a phase edge k6 may send an event or two more than planned (ids n >= plannedEvents), and those are
  // counted in kafka_writer_message_count too, so without the margin logged < sent with nothing lost.
  const eventsSql = buildEventCountsSql({
    selector: ctx.selector,
    phasePlan: candidatePhasePlan(ctx.phasePlan),
  });
  const events = await runTimedQuery(ctx.pgPool, { sql: eventsSql, params: [source], timeoutMs });
  const counts = events.rows[0] ?? {};
  const logged = toNumber(counts.logged) ?? 0;
  const matched = toNumber(counts.matched) ?? 0;
  const zeroMatch = toNumber(counts.zero_match) ?? 0;
  checks.push(
    check({
      id: 'matcher.logged-equals-sent',
      description:
        `Every event written to Kafka is in matcher_event_log (sent = k6 ${sent.source ?? 'counter missing'})` +
        drainingNote,
      expected: sent.value,
      actual: logged,
      // Without a k6 summary there is nothing to compare with: noted, not failed.
      severity: sent.value === null ? 'info' : untilDrained,
      sql: eventsSql,
      durationMs: events.durationMs,
    }),
  );
  checks.push(
    check({
      id: 'matcher.all-matched',
      description:
        zeroMatch > 0
          ? `Every logged event matched a plan definition (${formatNumber(zeroMatch)} ZERO_MATCH: is the set ACTIVE and refreshed?)`
          : 'Every logged event matched a plan definition (processing_status MATCHED)',
      expected: logged,
      actual: matched,
      severity: 'required',
      sql: eventsSql,
    }),
  );

  // 2. Enrolments: one new patient per event, enrolled once per matching plan definition.
  const floor = uuidV7LowerBound(ctx.context?.startedAt ?? ctx.times?.k6StartedAt ?? Date.now());
  const enrolmentSql = buildEnrolmentCountsSql();
  const enrolments = await runTimedQuery(ctx.pgPool, {
    sql: enrolmentSql,
    params: [floor, ctx.selector],
    timeoutMs,
  });
  const enrolmentRow = enrolments.rows[0] ?? {};
  const enrolmentCount = toNumber(enrolmentRow.enrolments) ?? 0;
  const patients = toNumber(enrolmentRow.patients) ?? 0;
  const set = ctx.planDefinitionSet ?? {};
  const fanOut = set.fanOut ?? null;
  const effectiveFanOut = set.effectiveFanOut ?? fanOut;
  const extra = effectiveFanOut !== null && fanOut !== null ? effectiveFanOut - fanOut : 0;
  checks.push(
    check({
      id: 'matcher.patients-enrolled',
      description: `Every event enrolled its (new) patient${drainingNote}`,
      // EVENT_MODE=single: each event is a new patient, so patients = events written.
      expected: sent.value,
      actual: patients,
      severity: sent.value === null ? 'info' : untilDrained,
      sql: enrolmentSql,
      durationMs: enrolments.durationMs,
    }),
  );
  checks.push(
    check({
      id: 'matcher.enrolments-equal-fan-out',
      description:
        `Enrolments = effective fan-out (${formatNumber(effectiveFanOut)}) × enrolled patients` +
        (extra > 0 ? ` (set ${set.name ?? '?'}: ${fanOut} + ${extra} other ACTIVE)` : ''),
      expected: effectiveFanOut === null ? null : effectiveFanOut * patients,
      actual: enrolmentCount,
      severity: effectiveFanOut === null ? 'info' : 'required',
      sql: enrolmentSql,
    }),
  );

  // 3. Steps: expected rows per event (set formula, plan §7.3), info until confirmed by a live smoke.
  const expectedRows = expectedRowsOf(ctx);
  const stepsSql = buildStepCountsSql();
  const steps = await runTimedQuery(ctx.pgPool, {
    sql: stepsSql,
    params: [floor, ctx.selector],
    timeoutMs,
  });
  checks.push(
    check({
      id: 'matcher.steps-created',
      description:
        `Step instances = ${formatNumber(expectedRows?.step_instance)} per event × logged events` +
        (extra > 0 ? ' (at least: other ACTIVE plan definitions add their own steps)' : '') +
        ' (rule to be confirmed by a live smoke run)',
      expected: expectedRows ? expectedRows.step_instance * logged : null,
      actual: toNumber(steps.rows[0]?.steps) ?? 0,
      comparison: extra > 0 ? 'at-least' : 'equals',
      severity: 'info',
      sql: stepsSql,
      durationMs: steps.durationMs,
    }),
  );

  // 4. Dead letters: measured by the watcher (Kafka offsets before the run cannot be read afterwards).
  const deadLetters = watchOutcome?.summary?.deadLetters ?? null;
  const measured = typeof deadLetters?.delta === 'number';
  checks.push(
    check({
      id: 'matcher.no-dead-letters',
      description: measured
        ? `No new records on the dead-letter topic ${deadLetters.topic ?? ''}`.trim()
        : 'No new records on the dead-letter topic (not measured: no watcher figures)',
      expected: ctx.settings.MATCHER_MAX_DEAD_LETTERS ?? 0,
      actual: measured ? deadLetters.delta : null,
      comparison: 'at-most',
      severity: measured ? 'required' : 'info',
    }),
  );
  return checks;
}
