/**
 * run-sql.mjs — index-friendly SQL to select ONE run's rows in CCE's database (plan §6.8).
 *
 * What:    The database collates text with en_US.utf8, so `LIKE 'LOADTEST-…%'` cannot use a btree
 *          index and scans whole tables (minutes on big tables). Instead:
 *          - event tables: test event ids are enumerable from the phase plan
 *            (<selector><phaseIndex>-<n>-<step>, n = 0 … plannedEvents−1), so the candidate ids are
 *            generated with generate_series and looked up through the unique (cloudevents_id, source) index;
 *          - CCE-created rows have time-ordered UUIDv7 ids: `id >= uuidV7Floor(run start − 5 min)` lets the
 *            primary key skip everything older before the LIKE is applied.
 *          Every data-check query runs with a statement_timeout and records its duration.
 * How:     import { candidateEventIdsSql, candidatePhasePlan, uuidV7LowerBound, runTimedQuery } from './run-sql.mjs';
 *          candidateEventIdsSql({ selector, phasePlan: candidatePhasePlan(phasePlan) })   (with the margin)
 * Needs:   A phase plan (run-context.json), the run's selector (LOADTEST-<runId>-<idCode>-).
 * Outputs: SQL text and { rows, durationMs, sql }.
 */
import { queryRows } from './clients/postgres.mjs';
import { uuidV7Floor } from './run-id.mjs';

/** Default statement_timeout of data-check queries: 5 minutes (plan §6.8). */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 5 * 60 * 1000;

/** Margin before the run start for UUIDv7 bounds (clock skew between hosts, warm-up). */
export const RUN_START_MARGIN_MS = 5 * 60 * 1000;

/** Selectors contain only these characters (plan §2.3), so they can be embedded as SQL literals. */
const SAFE_SELECTOR = /^LOADTEST-[A-Za-z0-9-]+-$/;

/**
 * Extra candidate ids per phase: 1 % + 10 (one rule for data checks and cleanup).
 * Why: at a phase edge k6 may start an iteration or two more than rate × duration; a candidate id that was
 * never sent is just an index miss, a missing one would hide a stored row (from the data checks and from
 * cleanup, whose verification uses the same candidates and so could not see it either).
 */
export const CANDIDATE_MARGIN = Object.freeze({ share: 0.01, extra: 10 });

/**
 * The phase plan as candidateEventIdsSql needs it, with CANDIDATE_MARGIN added to every phase that sends.
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
          : 0, // a phase without events stays empty
    })),
  };
}

/**
 * SQL returning one column `id` with every event id the run can have produced (plan §6.8).
 * Pass candidatePhasePlan(phasePlan), not the raw plan, so the k6 edge iterations are included.
 * Why: joining on the unique (cloudevents_id, source) index is fast; a LIKE scan is not.
 * @param {{selector:string, phasePlan:{phases:Array<{plannedEvents:number}>}, steps?:number[]}} input
 *   steps: journey step numbers (single-event tests: [1])
 * @returns {string} e.g. SELECT 'LOADTEST-…-col-' || '1-' || n || '-1' AS id FROM generate_series(0, 599) AS n …
 */
export function candidateEventIdsSql({ selector, phasePlan, steps = [1] }) {
  if (!SAFE_SELECTOR.test(selector)) throw new Error(`Unsafe selector "${selector}"`);
  const parts = [];
  phasePlan.phases.forEach((phase, phaseIndex) => {
    if (!(phase.plannedEvents > 0)) return;
    for (const step of steps) {
      parts.push(
        `SELECT '${selector}${phaseIndex}-' || n || '-${Number(step)}' AS id ` +
          `FROM generate_series(0, ${Math.floor(phase.plannedEvents) - 1}) AS n`,
      );
    }
  });
  // A plan without events still yields valid SQL (an empty set).
  return parts.length ? parts.join('\nUNION ALL\n') : 'SELECT NULL::text AS id WHERE false';
}

/**
 * Lower bound for UUIDv7 primary keys of rows created by a run: run start minus the margin.
 * Why: `id >= $floor` turns a full scan into an index range scan (plan §2.3).
 * @param {Date|string|number} runStart
 * @param {number} [marginMs]
 * @returns {string}
 */
export function uuidV7LowerBound(runStart, marginMs = RUN_START_MARGIN_MS) {
  return uuidV7Floor(new Date(new Date(runStart).getTime() - marginMs));
}

/** Tables whose live row counts describe the data volume a result was measured on (plan §6.8). */
export const DATA_VOLUME_TABLES = [
  'inbound_event_log',
  'matcher_event_log',
  'protocol_instance',
  'step_instance',
  'step_sla_state_transition',
  'deviation',
  'step_instance_history',
  'protocol_instance_history',
];

/**
 * Database size and live row counts from statistics (no table scan), plan §6.8.
 * Why: performance depends on how much data is already there; this is cheap enough for every run.
 */
export const DATA_VOLUME_SQL = `SELECT pg_database_size(current_database()) AS db_size_bytes,
       json_object_agg(relname, n_live_tup ORDER BY relname) AS rows
FROM pg_stat_user_tables
WHERE relname IN (${DATA_VOLUME_TABLES.map((table) => `'${table}'`).join(',')})`;

/**
 * Runs one query with a statement_timeout and measures how long it took.
 * Why: data checks keep their SQL and duration for transparency (DataCheck.sql, plan §6.8).
 * @param {object} pgPool
 * @param {{sql:string, params?:unknown[], timeoutMs?:number, now?:() => number}} input
 * @returns {Promise<{rows:object[], durationMs:number, sql:string}>}
 */
export async function runTimedQuery(
  pgPool,
  { sql, params = [], timeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS, now = Date.now },
) {
  const started = now();
  const rows = await queryRows(pgPool, sql, params, { statementTimeoutMs: timeoutMs });
  return { rows, durationMs: now() - started, sql };
}
