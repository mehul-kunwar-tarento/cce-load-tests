/**
 * collector-data-checks.mjs — after a collector run: did every accepted event really get stored?
 *
 * What:    k6 only sees the HTTP answers. These checks look in CCE's database to prove the collector did
 *          what it answered (plan §6.8):
 *          - collector.stored-equals-accepted (required): rows with status ACCEPTED in inbound_event_log
 *            for this run = events k6 saw answered 202 "accepted" (counter events_accepted). For a
 *            breakpoint run or a run that ended early: between "accepted" and "sent", because a request
 *            cut off on the client side may still have been stored;
 *          - collector.no-rejections (required): no row of this run with status REJECTED (422/500);
 *          - collector.downstream-logged (info): matcher_event_log rows for the same events (the matcher
 *            may still be draining, so this only informs);
 *          - collector.downstream-backlog-left (info): matcher consumer lag when the checks ran
 *            ("matcher still draining N events").
 *          Rows are found WITHOUT a LIKE scan: every event id the run can have produced is generated from
 *          the phase plan (LOADTEST-<runId>-col-<phaseIndex>-<n>-1) and joined on the unique
 *          (cloudevents_id, source) index; the source is a bound parameter ($1); each query has a
 *          statement_timeout and its SQL text and duration are kept on the check.
 * How:     Called by service-module.mjs dataChecks(ctx) after the run (and by `check-data` later):
 *            const checks = await runCollectorDataChecks(ctx);
 * Needs:   ctx.pgPool (DB_PASSWORD), ctx.selector, ctx.phasePlan, ctx.settings.EVENT_SOURCE, ctx.resultsDir
 *          with k6-summary.json, ctx.kafkaAdmin + ctx.scrape for the matcher backlog, ctx.times.
 * Outputs: DataCheck[] = { id, description, expected, actual, comparison, passed, severity, sql, durationMs }.
 *          For comparison 'between', expected is [lower, upper] = [k6 accepted, k6 sent].
 */
import path from 'node:path';
import {
  candidateEventIdsSql,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  formatNumber,
  metricValue,
  normaliseK6Summary,
  readJsonIfExists,
  readMatcherBacklog,
  runTimedQuery,
} from '../shared.mjs';

/**
 * Extra candidate ids per phase: 1 % + 10.
 * Why: at a phase edge k6 may start an iteration or two more than rate × duration; a candidate id that was
 * never sent is just an index miss, a missing one would hide a stored row.
 */
export const CANDIDATE_MARGIN = Object.freeze({ share: 0.01, extra: 10 });

/**
 * The phase plan as candidateEventIdsSql needs it, with the margin added to every phase that sends.
 * Why: keeps the phase index of each phase (ids carry it) while widening the id range a little.
 * @param {{phases: Array<{plannedEvents:number}>}} phasePlan
 * @returns {{phases: Array<{plannedEvents:number}>}}
 */
export function candidatePhasePlan(phasePlan) {
  return {
    phases: phasePlan.phases.map((phase) => ({
      plannedEvents:
        phase.plannedEvents > 0
          ? phase.plannedEvents +
            Math.ceil(phase.plannedEvents * CANDIDATE_MARGIN.share) +
            CANDIDATE_MARGIN.extra
          : 0, // a phase without events (none today) stays empty
    })),
  };
}

/**
 * SQL counting this run's inbound_event_log rows per status. $1 = the CloudEvent source.
 * Why: one index-driven pass answers both required checks (ACCEPTED and REJECTED) and spots rows stuck
 * in RECEIVED (inserted but never finished).
 * @param {string} candidateSql query returning column `id` (candidateEventIdsSql)
 * @returns {string}
 */
export function buildInboundStatusSql(candidateSql) {
  return `WITH candidates AS (
${candidateSql}
)
SELECT count(*) FILTER (WHERE i.status = 'ACCEPTED') AS accepted,
       count(*) FILTER (WHERE i.status = 'REJECTED') AS rejected,
       count(*) FILTER (WHERE i.status = 'RECEIVED') AS received,
       count(*) AS stored
FROM candidates c
JOIN inbound_event_log i ON i.cloudevents_id = c.id AND i.source = $1`;
}

/**
 * SQL counting this run's matcher_event_log rows. $1 = the CloudEvent source.
 * Why: every accepted collector event is published to Kafka and logged by the matcher; this shows how
 * far the downstream got (informational).
 * @param {string} candidateSql
 * @returns {string}
 */
export function buildDownstreamLoggedSql(candidateSql) {
  return `WITH candidates AS (
${candidateSql}
)
SELECT count(*) AS logged
FROM candidates c
JOIN matcher_event_log m ON m.cloudevents_id = c.id AND m.source = $1`;
}

/**
 * Events sent and accepted according to k6 (all phases: the candidate ids cover warm-up too).
 * Why: the expected side of "stored = accepted" is what the collector answered, as k6 counted it.
 * @param {object|null} k6Summary raw k6-summary.json
 * @returns {{sent:number|null, accepted:number|null}|null} null when there is no summary
 */
export function readK6Counts(k6Summary) {
  if (!k6Summary) return null;
  const normalised = normaliseK6Summary(k6Summary);
  return {
    sent:
      metricValue(normalised, 'events_sent', 'count') ??
      metricValue(normalised, 'iterations', 'count'),
    accepted: metricValue(normalised, 'events_accepted', 'count'),
  };
}

/**
 * True when sending did not run to its planned end (breakpoint by design, abort rule, Ctrl-C).
 * Why: then a request may have been stored although k6 never saw its answer (plan §6.8 "between").
 * @param {object} ctx run ctx (or check-data ctx, which carries the finished result)
 * @returns {boolean}
 */
export function endedEarly(ctx) {
  return (
    ctx.phasePlan?.testType === 'breakpoint' ||
    Boolean(ctx.times?.sendEndedEarly) ||
    ctx.result?.status === 'aborted'
  );
}

/** Turns a count column (pg returns bigint as text) into a number; why: comparisons need numbers. */
function toCount(value) {
  return value === null || value === undefined ? 0 : Number(value);
}

/**
 * collector.stored-equals-accepted (required).
 * @param {{storedAccepted:number, counts:{sent:number|null, accepted:number|null}|null, early:boolean,
 *          sql?:string, durationMs?:number}} input
 * @returns {object} DataCheck
 */
export function storedEqualsAcceptedCheck({ storedAccepted, counts, early, sql, durationMs }) {
  const base = {
    id: 'collector.stored-equals-accepted',
    actual: storedAccepted,
    severity: 'required',
    sql,
    durationMs: durationMs ?? null,
  };
  if (!counts || counts.accepted === null) {
    return {
      ...base,
      description:
        'Every event k6 saw accepted is stored as ACCEPTED (k6-summary.json missing: nothing to compare with)',
      expected: null,
      comparison: 'equals',
      passed: false,
    };
  }
  if (early) {
    const sent = counts.sent ?? counts.accepted;
    return {
      ...base,
      description:
        `Accepted events are stored as ACCEPTED: between ${formatNumber(counts.accepted)} (k6 saw 202 "accepted") ` +
        `and ${formatNumber(sent)} (sent), because sending stopped before its planned end and a request cut ` +
        'off on the client may still have been stored',
      // 'between' always stores [lower, upper] (same shape as the matcher checks), so the report can
      // print "between A and B" without reading the description.
      expected: [counts.accepted, sent],
      comparison: 'between',
      passed: storedAccepted >= counts.accepted && storedAccepted <= sent,
    };
  }
  return {
    ...base,
    description: 'Every event k6 saw accepted (202 "accepted") is stored as ACCEPTED',
    expected: counts.accepted,
    comparison: 'equals',
    passed: storedAccepted === counts.accepted,
  };
}

/**
 * collector.no-rejections (required): no row of this run stored as REJECTED.
 * @param {{rejected:number, received:number, sql?:string, durationMs?:number}} input
 * @returns {object} DataCheck
 */
export function noRejectionsCheck({ rejected, received, sql, durationMs }) {
  // RECEIVED rows were inserted but never finished (e.g. the service died mid-request): worth a mention.
  const stuck =
    received > 0 ? `; also ${formatNumber(received)} rows still RECEIVED (never finished)` : '';
  return {
    id: 'collector.no-rejections',
    description: `No event of this run stored as REJECTED (validation or Kafka publish failure)${stuck}`,
    expected: 0,
    actual: rejected,
    comparison: 'equals',
    passed: rejected === 0,
    severity: 'required',
    sql,
    durationMs: durationMs ?? null,
  };
}

/**
 * collector.downstream-logged (info): matcher_event_log rows = stored ACCEPTED rows.
 * @param {{logged:number, storedAccepted:number, sql?:string, durationMs?:number}} input
 * @returns {object} DataCheck
 */
export function downstreamLoggedCheck({ logged, storedAccepted, sql, durationMs }) {
  return {
    id: 'collector.downstream-logged',
    description:
      'Accepted events the matcher has logged so far (info: it may still be draining Kafka)',
    expected: storedAccepted,
    actual: logged,
    comparison: 'equals',
    passed: logged === storedAccepted,
    severity: 'info',
    sql,
    durationMs: durationMs ?? null,
  };
}

/**
 * collector.downstream-backlog-left (info): matcher consumer lag when the checks ran (plan §6.6).
 * Why: the report then says "matcher still draining N events", and the next test should wait for it.
 * @param {{lag:number|null}} input
 * @returns {object} DataCheck
 */
export function downstreamBacklogCheck({ lag }) {
  let description;
  if (lag === null || lag === undefined) {
    description =
      'Matcher backlog after the collector run (not measured: Kafka lag could not be read)';
  } else if (lag > 0) {
    description = `Matcher backlog after the collector run: still draining ${formatNumber(lag)} events (wait before the next test)`;
  } else {
    description = 'Matcher backlog after the collector run (0 = the matcher kept up)';
  }
  return {
    id: 'collector.downstream-backlog-left',
    description,
    expected: 0,
    actual: lag ?? null,
    comparison: 'equals',
    passed: lag === 0,
    severity: 'info',
    durationMs: null,
  };
}

/**
 * Default way to read the run's k6 summary: <resultsDir>/k6-summary.json.
 * Why: the runner calls dataChecks(ctx) before it loads the summary, and ctx has no summary field.
 */
function readSummaryFromResults(ctx) {
  return ctx.resultsDir ? readJsonIfExists(path.join(ctx.resultsDir, 'k6-summary.json')) : null;
}

/**
 * Runs every collector data check (plan §6.8).
 * @param {object} ctx run ctx (plan §6.4) or the ctx `check-data` rebuilds
 * @param {{readSummary?:(ctx:object)=>object|null, readBacklog?:(ctx:object)=>Promise<{lag:number|null}>,
 *          timeoutMs?:number}} [options] injected by unit tests
 * @returns {Promise<object[]>} DataCheck[]
 */
export async function runCollectorDataChecks(
  ctx,
  {
    readSummary = readSummaryFromResults,
    readBacklog = readMatcherBacklog,
    timeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS,
  } = {},
) {
  if (!ctx.pgPool) {
    // The runner turns a thrown error into a failed "collector.data-checks-ran" check with this text.
    throw new Error(
      'no database connection: set DB_PASSWORD (or the variable the environment names)',
    );
  }
  const source = ctx.settings?.EVENT_SOURCE ?? ctx.context?.dataset?.source ?? null;
  if (!source)
    throw new Error('no CloudEvent source: EVENT_SOURCE and the dataset source are empty');

  // Backlog first: it is the "when the collector run ended" figure; the SQL below may take a while.
  let lag = null;
  try {
    ({ lag } = await readBacklog(ctx));
  } catch (error) {
    ctx.logger?.warn?.(`matcher backlog not measured: ${error.message}`);
  }

  const candidateSql = candidateEventIdsSql({
    selector: ctx.selector,
    phasePlan: candidatePhasePlan(ctx.phasePlan),
  });
  ctx.logger?.info?.('data checks: counting this run’s rows in inbound_event_log …');
  const inbound = await runTimedQuery(ctx.pgPool, {
    sql: buildInboundStatusSql(candidateSql),
    params: [source],
    timeoutMs,
  });
  const row = inbound.rows[0] ?? {};
  const storedAccepted = toCount(row.accepted);

  ctx.logger?.info?.('data checks: counting this run’s rows in matcher_event_log …');
  const downstream = await runTimedQuery(ctx.pgPool, {
    sql: buildDownstreamLoggedSql(candidateSql),
    params: [source],
    timeoutMs,
  });

  const counts = readK6Counts(readSummary(ctx));
  return [
    storedEqualsAcceptedCheck({
      storedAccepted,
      counts,
      early: endedEarly(ctx),
      sql: inbound.sql,
      durationMs: inbound.durationMs,
    }),
    noRejectionsCheck({
      rejected: toCount(row.rejected),
      received: toCount(row.received),
      sql: inbound.sql,
      durationMs: inbound.durationMs,
    }),
    downstreamLoggedCheck({
      logged: toCount(downstream.rows[0]?.logged),
      storedAccepted,
      sql: downstream.sql,
      durationMs: downstream.durationMs,
    }),
    downstreamBacklogCheck({ lag }),
  ];
}
