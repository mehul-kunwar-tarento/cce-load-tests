/**
 * cleanup-tables.mjs — which tables cleanup touches, in which order, and the SQL for each step
 *
 * What:    The 13 tables load tests write to, child tables first (plan §7.2), and pure builders for every
 *          statement cleanup runs: schema detection, staging the ids to delete into TEMP tables (lt_*),
 *          "snapshot" copies of those lists (lt_*_all, used only to verify), counts, one batched delete per
 *          transaction, verification (by snapshot and by direct predicate / orphans) and the extra "orphan
 *          round". Selectors always end with the service id code (LOADTEST-<runId>-col-, -mat-, -sla-) so one
 *          run never matches another; --all uses LOADTEST-. The legacy v1 branch also selects by the JSONB
 *          patient reference, because v1 event ids were random UUIDs.
 *          Values are validated and inlined as SQL literals, so `--print-sql` output can be run as printed.
 * How:     import { CLEANUP_TABLES, buildStageSql, buildBatchDeleteSql, buildVerifySql } from './cleanup-tables.mjs';
 * Needs:   Nothing (pure). Run selectors come from A2's tools/core/run-id.mjs.
 * Outputs: SQL strings / arrays of SQL strings.
 */
import { runSelectors, validateRunId } from '../core/run-id.mjs';

/** Temporary index that makes deleting matcher_event_log rows fast (FK from step_instance has no index). */
export const TEMP_INDEX_NAME = 'loadtest_cleanup_matched_event';

/** Tables cleanup never touches: plan definitions are handled by `plan-definitions retire|delete`. */
export const NEVER_TOUCHED = Object.freeze([
  'protocol_definition',
  'trigger_index',
  'action_definition',
  'receiver_adaptor',
  'destination_adaptor_mapping',
  'notification_tracker',
]);

/**
 * The ordered table list (plan §7.2). `list` = TEMP table of staged ids; `parent` = how orphans are found.
 * Why child first: foreign keys point from children to parents, so parents can only go once children are gone.
 */
export const CLEANUP_TABLES = Object.freeze([
  {
    order: 1,
    table: 'intelligence_delivery_audit_log',
    list: 'lt_ida',
    optional: true,
    selector: 'intelligence_delivery_id in staged deliveries',
  },
  {
    order: 2,
    table: 'intelligence_delivery',
    list: 'lt_idl',
    optional: true,
    selector:
      'intelligence_event_id in staged intelligence events (subject LIKE selector with --all, or when the table has no intelligence_event_id)',
  },
  {
    order: 3,
    table: 'deviation',
    list: 'lt_dev',
    selector: 'step_instance_id in staged steps (+ step group column when present)',
  },
  {
    order: 4,
    table: 'step_sla_state_transition',
    list: 'lt_sst',
    selector: 'step_instance_id in staged steps (+ step group column when present)',
  },
  {
    order: 5,
    table: 'step_instance_history',
    list: 'lt_sih',
    selector: 'step_instance_id in staged steps (one hash join: no index)',
  },
  {
    order: 6,
    table: 'intelligence_event_log',
    list: 'lt_iel',
    selector: 'protocol_instance_id in staged instances (plus subject LIKE selector with --all)',
  },
  {
    order: 7,
    table: 'step_instance',
    list: 'lt_si',
    selector: 'protocol_instance_id in staged instances',
  },
  {
    order: 8,
    table: 'step_group_instance',
    list: 'lt_sgi',
    optional: true,
    singleStatement: true,
    selector: 'protocol_instance_id in staged instances (whole tree per statement)',
  },
  {
    order: 9,
    table: 'protocol_instance_history',
    list: 'lt_pih',
    selector: 'protocol_instance_id in staged instances',
  },
  { order: 10, table: 'protocol_instance', list: 'lt_pi', selector: 'patient_id LIKE selector' },
  {
    order: 11,
    table: 'matcher_event_log',
    list: 'lt_mel',
    needsTempIndex: true,
    selector:
      'cloudevents_id of the run (candidate ids or LIKE), plus events matched by staged steps',
  },
  {
    order: 12,
    table: 'inbound_event_log',
    list: 'lt_in',
    selector: 'cloudevents_id LIKE selector (bounded by source + received_at when known)',
  },
  {
    order: 13,
    table: 'facility',
    list: 'lt_fac',
    allOnly: true,
    selector: "facility_id LIKE 'LOADTEST-%' (--all only)",
  },
]);

/** Columns cleanup must know about (optional tables and the matcher V8 step-group columns). */
const DETECTED_TABLES = [...CLEANUP_TABLES.map((t) => t.table)];

/** Schema detection (one read-only query). */
export const SCHEMA_SQL =
  'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() ' +
  `AND table_name IN (${DETECTED_TABLES.map((t) => `'${t}'`).join(', ')}) ORDER BY table_name, column_name`;

/** Turn SCHEMA_SQL rows into { tables:Set, columns:Map<table, Set<column>> }. */
export function schemaFromRows(rows) {
  const tables = new Set();
  const columns = new Map();
  for (const { table_name: t, column_name: c } of rows) {
    tables.add(t);
    if (!columns.has(t)) columns.set(t, new Set());
    columns.get(t).add(c);
  }
  return { tables, columns };
}

/** Why: schema = null means "print mode": show every optional statement, marked as conditional. */
const hasTable = (schema, t) => (schema ? schema.tables.has(t) : true);
const hasColumn = (schema, t, c) => (schema ? Boolean(schema.columns.get(t)?.has(c)) : true);
/** Comment prefix for statements that only run when an optional table/column exists (print mode only). */
const onlyIf = (schema, what) => (schema ? '' : `/* only if ${what} exists */ `);

/** Quote a SQL string literal. Why: values are inlined so printed SQL runs as is. */
export function literal(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Why: selectors reach SQL as LIKE patterns; refuse anything that is not a plain LOADTEST id prefix. */
function assertSelector(selector) {
  if (!/^LOADTEST-[A-Za-z0-9-]*$/.test(selector))
    throw new Error(`Unsafe cleanup selector "${selector}"`);
}

/** `(col LIKE 'sel1%' OR col LIKE 'sel2%')`. */
function likeAny(column, selectors) {
  selectors.forEach(assertSelector);
  const parts = selectors.map((s) => `${column} LIKE ${literal(`${s}%`)}`);
  return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
}

/**
 * The selectors of a cleanup scope.
 * Why: per run = one selector per id code (never a bare prefix); legacy v1 ids had no id code, so legacy
 * uses LOADTEST-<runId>-; --all uses LOADTEST-.
 */
export function buildSelectors({ runId = null, all = false, legacyV1 = false }) {
  if (all) return ['LOADTEST-'];
  validateRunId(runId);
  return legacyV1 ? [`LOADTEST-${runId}-`] : runSelectors(runId);
}

/** The JSONB prefix of the legacy branch (patient id in the CloudEvent subject / FHIR reference). */
function legacyPrefix({ selectors }) {
  return selectors[0]; // legacy and --all both have exactly one selector
}

/**
 * Candidate event ids generated from a run's phase plan (plan §2.3, §6.8): patient
 * '<selector><phaseIndex>-<n>' and event '<patient>-1' (single-event mode), n < plannedEvents.
 * Why: lets Postgres look each id up through the unique (cloudevents_id, source) index instead of a LIKE scan.
 */
export function candidateIdsSql({ selector, phases }) {
  assertSelector(selector);
  const values = phases
    .map((p) => `(${Number(p.phaseIndex)}, ${Number(p.plannedEvents)})`)
    .join(', ');
  return (
    `SELECT ${literal(selector)} || ph.p || '-' || n || '-1' AS id FROM (VALUES ${values}) AS ph(p, cnt) ` +
    'CROSS JOIN LATERAL generate_series(0, ph.cnt - 1) AS n'
  );
}

/** Predicate on protocol_instance (alias t). */
function piPredicate(o) {
  const floor =
    !o.legacyV1 && o.bounds?.floor ? `t.id >= ${literal(o.bounds.floor)}::uuid AND ` : '';
  return `${floor}${likeAny('t.patient_id', o.selectors)}`;
}

/** Predicate on inbound_event_log (alias t), incl. the legacy JSONB branch. */
function inboundPredicate(o) {
  const b = !o.legacyV1 && o.bounds ? o.bounds : null;
  const bound = [
    b?.source ? `t.source = ${literal(b.source)}` : null,
    b?.runStart
      ? `t.received_at >= ${literal(b.runStart)}::timestamptz - interval '5 minutes'`
      : null,
  ].filter(Boolean);
  const main = `${bound.length ? `${bound.join(' AND ')} AND ` : ''}${likeAny('t.cloudevents_id', o.selectors)}`;
  if (!o.legacyV1) return main;
  return `(${main} OR t.raw_payload->>'subject' LIKE ${literal(`${legacyPrefix(o)}%`)})`;
}

/** Predicate on matcher_event_log (alias t): candidate ids when known, else LIKE; plus the legacy branch. */
function matcherPredicate(o) {
  const c = !o.legacyV1 ? o.bounds?.candidates : null;
  const main =
    c && o.bounds?.source
      ? `(t.cloudevents_id, t.source) IN (SELECT c.id, ${literal(o.bounds.source)} FROM (${candidateIdsSql(c)}) AS c)`
      : likeAny('t.cloudevents_id', o.selectors);
  if (!o.legacyV1) return main;
  return `(${main} OR t.data->'subject'->>'reference' LIKE ${literal(`Patient/${legacyPrefix(o)}%`)})`;
}

/** Predicate on a table with an own `subject` column, if it has one. */
function subjectPredicate(o, table) {
  return hasColumn(o.schema, table, 'subject') ? likeAny('t.subject', o.selectors) : null;
}

/**
 * The `subject LIKE` sweep of intelligence_event_log / intelligence_delivery, or null.
 * Why: neither table has an index on subject (matcher V1: "no query has ever selected on either"), so an
 *      OR with this LIKE turns stage, verify and orphan round into full scans. Per run it adds nothing:
 *      every row of a run belongs to one of its protocol instances (protocol_instance_id is NOT NULL) or,
 *      for deliveries, to one of its intelligence events. It is kept for --all (sweeps orphans whose
 *      protocol instance is already gone) and for a delivery table without intelligence_event_id (then
 *      the subject is its only link).
 */
function subjectSweep(o, table) {
  if (o.all) return subjectPredicate(o, table);
  if (table === 'intelligence_delivery' && !hasColumn(o.schema, table, 'intelligence_event_id'))
    return subjectPredicate(o, table);
  return null;
}

/**
 * The direct predicate of a table for verification and the orphan round (alias t).
 * Child tables without an own selector use their parent's SNAPSHOT (lt_pi_all / lt_si_all): rows whose
 * parent was staged, even if written after staging (e.g. a history row added by Step SLA mid-cleanup).
 */
export function directPredicate(entry, o) {
  const or = (...parts) => {
    const kept = parts.filter(Boolean);
    return kept.length === 0 ? 'FALSE' : kept.length === 1 ? kept[0] : `(${kept.join(' OR ')})`;
  };
  const groupColumn = (table) =>
    hasColumn(o.schema, table, 'step_group_instance_id') &&
    hasTable(o.schema, 'step_group_instance')
      ? `${onlyIf(o.schema, `column ${table}.step_group_instance_id`)}t.step_group_instance_id IN (SELECT id FROM lt_sgi_all)`
      : null;
  switch (entry.table) {
    case 'intelligence_delivery_audit_log':
      return 't.intelligence_delivery_id IN (SELECT id FROM lt_idl_all)';
    case 'intelligence_delivery':
      return or(
        hasColumn(o.schema, entry.table, 'intelligence_event_id')
          ? 't.intelligence_event_id IN (SELECT id FROM lt_iel_all)'
          : null,
        subjectSweep(o, entry.table),
      );
    case 'deviation':
    case 'step_sla_state_transition':
      return or('t.step_instance_id IN (SELECT id FROM lt_si_all)', groupColumn(entry.table));
    case 'step_instance_history':
      return 't.step_instance_id IN (SELECT id FROM lt_si_all)';
    case 'intelligence_event_log':
      return or(
        't.protocol_instance_id IN (SELECT id FROM lt_pi_all)',
        subjectSweep(o, entry.table),
      );
    case 'step_instance':
    case 'step_group_instance':
    case 'protocol_instance_history':
      return 't.protocol_instance_id IN (SELECT id FROM lt_pi_all)';
    case 'protocol_instance':
      return piPredicate(o);
    case 'matcher_event_log':
      return matcherPredicate(o);
    case 'inbound_event_log':
      return inboundPredicate(o);
    case 'facility':
      return "t.facility_id LIKE 'LOADTEST-%'";
    default:
      throw new Error(`Unknown cleanup table ${entry.table}`);
  }
}

/** Whether a table takes part in this cleanup, and why not when it does not. */
export function tableInScope(entry, o) {
  if (entry.allOnly && !o.all)
    return {
      inScope: false,
      reason: 'only with --all (per-run cleanup leaves the shared LOADTEST facility)',
    };
  if (entry.optional && !hasTable(o.schema, entry.table))
    return { inScope: false, reason: 'table does not exist in this database' };
  return { inScope: true, reason: null };
}

/**
 * Stage SQL: TEMP tables with the ids to delete, primary keys, snapshots, ANALYZE (plan §7.2).
 * @param {{selectors:string[], all:boolean, legacyV1:boolean, bounds:object|null, schema:object|null}} o
 */
export function buildStageSql(o) {
  const s = o.schema;
  const sql = [];
  const lists = [];
  const stage = (list, text, condition = null) => {
    sql.push(`${condition ? onlyIf(s, condition) : ''}CREATE TEMP TABLE ${list} AS ${text}`);
    lists.push(list);
  };
  const sgi = hasTable(s, 'step_group_instance');
  stage('lt_pi', `SELECT t.id FROM protocol_instance t WHERE ${piPredicate(o)}`);
  stage(
    'lt_si',
    'SELECT s.id, s.matched_event_id FROM step_instance s JOIN lt_pi p ON s.protocol_instance_id = p.id',
  );
  if (sgi)
    stage(
      'lt_sgi',
      'SELECT g.id FROM step_group_instance g JOIN lt_pi p ON g.protocol_instance_id = p.id',
      'table step_group_instance',
    );
  stage(
    'lt_sih',
    'SELECT h.id FROM step_instance_history h JOIN lt_si s ON h.step_instance_id = s.id',
  );
  stage(
    'lt_pih',
    'SELECT h.id FROM protocol_instance_history h JOIN lt_pi p ON h.protocol_instance_id = p.id',
  );
  const ielSubject = subjectSweep(o, 'intelligence_event_log');
  stage(
    'lt_iel',
    `SELECT t.id FROM intelligence_event_log t WHERE t.protocol_instance_id IN (SELECT id FROM lt_pi)${ielSubject ? ` OR ${ielSubject}` : ''}`,
  );
  if (hasTable(s, 'intelligence_delivery')) {
    const parts = [
      hasColumn(s, 'intelligence_delivery', 'intelligence_event_id')
        ? 't.intelligence_event_id IN (SELECT id FROM lt_iel)'
        : null,
      subjectSweep(o, 'intelligence_delivery'),
    ].filter(Boolean);
    stage(
      'lt_idl',
      `SELECT t.id FROM intelligence_delivery t WHERE ${parts.join(' OR ') || 'FALSE'}`,
      'table intelligence_delivery',
    );
    if (hasTable(s, 'intelligence_delivery_audit_log')) {
      stage(
        'lt_ida',
        'SELECT t.id FROM intelligence_delivery_audit_log t WHERE t.intelligence_delivery_id IN (SELECT id FROM lt_idl)',
        'table intelligence_delivery_audit_log',
      );
    }
  }
  for (const [list, table, alias] of [
    ['lt_dev', 'deviation', 'd'],
    ['lt_sst', 'step_sla_state_transition', 'x'],
  ]) {
    const groups =
      sgi && hasColumn(s, table, 'step_group_instance_id')
        ? ` UNION ${onlyIf(s, `column ${table}.step_group_instance_id`)}SELECT ${alias}.id FROM ${table} ${alias} JOIN lt_sgi g ON ${alias}.step_group_instance_id = g.id`
        : '';
    stage(
      list,
      `SELECT ${alias}.id FROM ${table} ${alias} JOIN lt_si s ON ${alias}.step_instance_id = s.id${groups}`,
    );
  }
  stage(
    'lt_mel',
    `SELECT t.id FROM matcher_event_log t WHERE ${matcherPredicate(o)} UNION SELECT matched_event_id FROM lt_si WHERE matched_event_id IS NOT NULL`,
  );
  stage('lt_in', `SELECT t.id FROM inbound_event_log t WHERE ${inboundPredicate(o)}`);
  if (o.all) stage('lt_fac', "SELECT t.id FROM facility t WHERE t.facility_id LIKE 'LOADTEST-%'");
  // Primary keys: the batch deletes look ids up by key; snapshots are never consumed by deletes.
  for (const list of lists) sql.push(`ALTER TABLE ${list} ADD PRIMARY KEY (id)`);
  for (const list of lists) {
    sql.push(`CREATE TEMP TABLE ${list}_all AS SELECT id FROM ${list}`);
    sql.push(`ALTER TABLE ${list}_all ADD PRIMARY KEY (id)`);
  }
  for (const list of lists) sql.push(`ANALYZE ${list}`, `ANALYZE ${list}_all`);
  return sql;
}

/** Rows staged for one table ("before"). */
export function buildCountSql(entry) {
  return `SELECT count(*)::bigint AS n FROM ${entry.list}`;
}

/**
 * One batch, as its own explicit transaction (SET LOCAL only works inside one).
 * The statement removes up to `batchSize` ids from the staged list and deletes those rows from the table,
 * returning both counts: the loop stops when nothing is staged any more.
 */
export function buildBatchDeleteSql(entry, { batchSize = 10000, lockTimeoutSeconds = 5 } = {}) {
  const take = entry.singleStatement
    ? `DELETE FROM ${entry.list} RETURNING id` // whole tree in one statement (self-referencing FK)
    : `DELETE FROM ${entry.list} WHERE id IN (SELECT id FROM ${entry.list} LIMIT ${Math.max(1, Math.floor(batchSize))}) RETURNING id`;
  return [
    'BEGIN',
    `SET LOCAL lock_timeout = '${Math.max(1, Math.round(lockTimeoutSeconds * 1000))}ms'`,
    `WITH b AS (${take}), d AS (DELETE FROM ${entry.table} t USING b WHERE t.id = b.id RETURNING 1) ` +
      'SELECT (SELECT count(*) FROM b)::bigint AS staged, (SELECT count(*) FROM d)::bigint AS deleted',
    'COMMIT',
  ];
}

/** Verification: rows staged before deleting that still exist, and rows the direct predicate still finds. */
export function buildVerifySql(entry, o) {
  return {
    snapshotSql: `SELECT count(*)::bigint AS n FROM ${entry.table} WHERE id IN (SELECT id FROM ${entry.list}_all)`,
    predicateSql: `SELECT count(*)::bigint AS n FROM ${entry.table} t WHERE ${directPredicate(entry, o)}`,
  };
}

/** Orphan round: stage what the predicate still finds (into the list and its snapshot) for one more pass. */
export function buildRestageSql(entry, o) {
  const columns = entry.table === 'step_instance' ? 'id, matched_event_id' : 'id';
  const select = entry.table === 'step_instance' ? 't.id, t.matched_event_id' : 't.id';
  return [
    `INSERT INTO ${entry.list} (${columns}) SELECT ${select} FROM ${entry.table} t WHERE ${directPredicate(entry, o)} ON CONFLICT DO NOTHING`,
    `INSERT INTO ${entry.list}_all (id) SELECT id FROM ${entry.list} ON CONFLICT DO NOTHING`,
  ];
}

/** Activity counts for the dev/uat "still processing" guard (two reads IDLE_FLAT_DURATION apart). */
export function buildActivitySql(o, { now = new Date(), uuidFloorOfLastHour = null } = {}) {
  if (o.all) {
    const floor = uuidFloorOfLastHour ? `t.id >= ${literal(uuidFloorOfLastHour)}::uuid AND ` : '';
    return (
      `SELECT (SELECT count(*) FROM protocol_instance t WHERE ${floor}t.patient_id LIKE 'LOADTEST-%')::bigint AS protocol_instance, ` +
      `(SELECT count(*) FROM matcher_event_log t WHERE t.received_at >= ${literal(new Date(now.getTime() - 3600_000).toISOString())}::timestamptz ` +
      "AND t.cloudevents_id LIKE 'LOADTEST-%')::bigint AS matcher_event_log"
    );
  }
  return (
    `SELECT (SELECT count(*) FROM protocol_instance t WHERE ${piPredicate(o)})::bigint AS protocol_instance, ` +
    `(SELECT count(*) FROM matcher_event_log t WHERE ${matcherPredicate(o)})::bigint AS matcher_event_log`
  );
}

/** Notes about full scans, printed with the plan and saved in the JSON (plan §7.2). */
export function scanNotes(o) {
  const notes = [];
  if (o.all)
    notes.push(
      '--all: intelligence_event_log (and intelligence_delivery) are also selected by subject LIKE, which has no index (full scan: may take minutes on large tables)',
    );
  else if (
    hasTable(o.schema, 'intelligence_delivery') &&
    !hasColumn(o.schema, 'intelligence_delivery', 'intelligence_event_id') &&
    hasColumn(o.schema, 'intelligence_delivery', 'subject')
  )
    notes.push(
      'intelligence_delivery has no intelligence_event_id column: it is selected by subject LIKE (full scan: may take minutes on large tables)',
    );
  if (o.legacyV1)
    notes.push(
      'legacy v1 branch: JSONB subject scans of inbound_event_log and matcher_event_log, no time bound (full scan: may take minutes on large tables)',
    );
  else if (!o.bounds?.floor)
    notes.push(
      'run start unknown: protocol_instance and event tables are scanned in full (full scan: may take minutes on large tables)',
    );
  else if (!o.bounds?.candidates)
    notes.push(
      'run-context.json not found: matcher_event_log is selected by LIKE (full scan: may take minutes on large tables)',
    );
  if (!o.legacyV1 && o.bounds?.startSource === 'run-id-earliest')
    notes.push(
      `run start guessed from the run id (no run-context.json on this machine): its clock is the run host's local time in an unknown zone, so the lower bound is that clock read as UTC minus 14 h (${o.bounds.runStart}); scans may cover up to 14 h more rows`,
    );
  return notes;
}
