/**
 * cleanup-tables.spec.mjs — unit tests of the pure SQL builders in tools/cleanup/cleanup-tables.mjs (plan §7.2)
 *
 * What:    The 13-table list and its order; run selectors ending with the id codes; stage SQL detecting the
 *          optional tables/columns (step_group_instance, intelligence_delivery(_audit_log), V8
 *          step_group_instance_id); UUIDv7 floor, candidate ids and source + received_at bounds when known,
 *          the legacy v1 JSONB branch only when asked; the intelligence tables' subject LIKE only with --all;
 *          snapshots lt_*_all; batch statements framed as
 *          BEGIN / SET LOCAL / delete / COMMIT; verification by snapshot and by direct predicate / orphans;
 *          the never-touched tables never written; printCleanupSql covering all 13 tables.
 * How:     npm test   (or: node --test tools/cleanup/unit-tests/cleanup-tables.spec.mjs)
 * Needs:   Nothing (pure functions; printCleanupSql connects to nothing).
 * Outputs: node:test results only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { resolveSettings } from '../../core/settings.mjs';
import { localEnvironment } from '../../preflight/unit-tests/fake-clients.mjs';
import { printCleanupSql } from '../cleanup.mjs';
import {
  CLEANUP_TABLES,
  NEVER_TOUCHED,
  buildBatchDeleteSql,
  buildSelectors,
  buildStageSql,
  buildVerifySql,
  candidateIdsSql,
  literal,
  scanNotes,
  schemaFromRows,
} from '../cleanup-tables.mjs';

const RUN_ID = '20261105-142233';
const SELECTORS = buildSelectors({ runId: RUN_ID });

/** A detected schema: base tables, optionally the V8 step-group parts and the intelligence delivery tables. */
function schema({ stepGroups = false, delivery = false } = {}) {
  const rows = [];
  const add = (table, ...columns) =>
    ['id', ...columns].forEach((column_name) => rows.push({ table_name: table, column_name }));
  add('deviation', 'step_instance_id', ...(stepGroups ? ['step_group_instance_id'] : []));
  add(
    'step_sla_state_transition',
    'step_instance_id',
    ...(stepGroups ? ['step_group_instance_id'] : []),
  );
  add('step_instance_history', 'step_instance_id');
  add('intelligence_event_log', 'protocol_instance_id', 'subject');
  add('step_instance', 'protocol_instance_id', 'matched_event_id');
  add('protocol_instance_history', 'protocol_instance_id');
  add('protocol_instance', 'patient_id');
  add('matcher_event_log', 'cloudevents_id', 'source');
  add('inbound_event_log', 'cloudevents_id', 'source', 'received_at');
  add('facility', 'facility_id');
  if (stepGroups) add('step_group_instance', 'protocol_instance_id');
  if (delivery) {
    add('intelligence_delivery', 'intelligence_event_id', 'subject');
    add('intelligence_delivery_audit_log', 'intelligence_delivery_id');
  }
  return schemaFromRows(rows);
}

const stage = (o) =>
  buildStageSql({
    selectors: SELECTORS,
    all: false,
    legacyV1: false,
    bounds: null,
    schema: schema(),
    ...o,
  }).join(';\n');

describe('CLEANUP_TABLES', () => {
  it('lists the 13 tables child first, exactly as plan §7.2', () => {
    assert.deepEqual(
      CLEANUP_TABLES.map((t) => [t.order, t.table, t.list]),
      [
        [1, 'intelligence_delivery_audit_log', 'lt_ida'],
        [2, 'intelligence_delivery', 'lt_idl'],
        [3, 'deviation', 'lt_dev'],
        [4, 'step_sla_state_transition', 'lt_sst'],
        [5, 'step_instance_history', 'lt_sih'],
        [6, 'intelligence_event_log', 'lt_iel'],
        [7, 'step_instance', 'lt_si'],
        [8, 'step_group_instance', 'lt_sgi'],
        [9, 'protocol_instance_history', 'lt_pih'],
        [10, 'protocol_instance', 'lt_pi'],
        [11, 'matcher_event_log', 'lt_mel'],
        [12, 'inbound_event_log', 'lt_in'],
        [13, 'facility', 'lt_fac'],
      ],
    );
  });
});

describe('buildSelectors', () => {
  it('per run: one selector per id code, never a bare prefix', () => {
    assert.deepEqual(SELECTORS, [
      `LOADTEST-${RUN_ID}-col-`,
      `LOADTEST-${RUN_ID}-mat-`,
      `LOADTEST-${RUN_ID}-sla-`,
    ]);
  });
  it('legacy v1: LOADTEST-<runId>- (v1 had no id codes); --all: LOADTEST-', () => {
    assert.deepEqual(buildSelectors({ runId: '1103172520', legacyV1: true }), [
      'LOADTEST-1103172520-',
    ]);
    assert.deepEqual(buildSelectors({ all: true }), ['LOADTEST-']);
  });
  it('refuses run ids that could match another run', () => {
    assert.throws(() => buildSelectors({ runId: 'test-2' }));
    assert.throws(() => buildSelectors({ runId: "x'; DROP TABLE y; --" }));
  });
});

describe('buildStageSql', () => {
  it('stages every list with a primary key, a snapshot lt_*_all and ANALYZE', () => {
    const sql = buildStageSql({
      selectors: SELECTORS,
      all: false,
      legacyV1: false,
      bounds: null,
      schema: schema(),
    });
    const lists = sql
      .map((s) => /^CREATE TEMP TABLE (lt_[a-z]+) AS SELECT (?!id FROM lt_)/.exec(s)?.[1])
      .filter(Boolean);
    assert.deepEqual(lists, [
      'lt_pi',
      'lt_si',
      'lt_sih',
      'lt_pih',
      'lt_iel',
      'lt_dev',
      'lt_sst',
      'lt_mel',
      'lt_in',
    ]);
    for (const list of lists) {
      assert.ok(sql.includes(`ALTER TABLE ${list} ADD PRIMARY KEY (id)`), list);
      assert.ok(
        sql.includes(`CREATE TEMP TABLE ${list}_all AS SELECT id FROM ${list}`),
        `${list} snapshot`,
      );
      assert.ok(sql.includes(`ANALYZE ${list}_all`), `${list} analyze`);
    }
  });

  it('detects the optional tables and the V8 step-group columns', () => {
    const plain = stage();
    assert.ok(!/lt_sgi|lt_idl|lt_ida/.test(plain), 'nothing staged for tables that do not exist');
    const v8 = stage({ schema: schema({ stepGroups: true, delivery: true }) });
    assert.match(
      v8,
      /CREATE TEMP TABLE lt_sgi AS SELECT g\.id FROM step_group_instance g JOIN lt_pi/,
    );
    assert.match(
      v8,
      /CREATE TEMP TABLE lt_dev AS .* UNION SELECT d\.id FROM deviation d JOIN lt_sgi g ON d\.step_group_instance_id = g\.id/,
    );
    // Per run: no unindexed subject LIKE on the intelligence tables (their rows hang off staged parents).
    assert.match(
      v8,
      /CREATE TEMP TABLE lt_idl AS SELECT t\.id FROM intelligence_delivery t WHERE t\.intelligence_event_id IN \(SELECT id FROM lt_iel\);\n/,
    );
    assert.match(
      v8,
      /CREATE TEMP TABLE lt_iel AS SELECT t\.id FROM intelligence_event_log t WHERE t\.protocol_instance_id IN \(SELECT id FROM lt_pi\);\n/,
    );
    // --all keeps the subject sweep (orphans whose protocol instance is gone) and says it scans.
    const all = stage({
      selectors: ['LOADTEST-'],
      all: true,
      schema: schema({ stepGroups: true, delivery: true }),
    });
    assert.match(all, /FROM intelligence_event_log t WHERE .* OR t\.subject LIKE 'LOADTEST-%'/);
    assert.match(all, /FROM intelligence_delivery t WHERE .* OR t\.subject LIKE 'LOADTEST-%'/);
    assert.match(
      scanNotes({ selectors: ['LOADTEST-'], all: true, legacyV1: true, schema: null }).join(' '),
      /subject LIKE, which has no index/,
    );
    assert.match(
      v8,
      /CREATE TEMP TABLE lt_ida AS SELECT t\.id FROM intelligence_delivery_audit_log t WHERE t\.intelligence_delivery_id IN \(SELECT id FROM lt_idl\)/,
    );
  });

  it('bounds the scans when the run start / run context is known', () => {
    const bounds = {
      floor: '01a1aae4-5488-7000-8000-000000000000',
      runStart: '2026-11-05T08:52:33.000Z',
      source: 'loadtest-emr',
      candidates: {
        selector: `LOADTEST-${RUN_ID}-mat-`,
        phases: [
          { phaseIndex: 0, plannedEvents: 600 },
          { phaseIndex: 1, plannedEvents: 30000 },
        ],
      },
    };
    const sql = stage({ bounds });
    assert.match(
      sql,
      /FROM protocol_instance t WHERE t\.id >= '01a1aae4-5488-7000-8000-000000000000'::uuid AND \(t\.patient_id LIKE 'LOADTEST-20261105-142233-col-%' OR/,
    );
    assert.match(
      sql,
      /\(t\.cloudevents_id, t\.source\) IN \(SELECT c\.id, 'loadtest-emr' FROM \(SELECT 'LOADTEST-20261105-142233-mat-' \|\| ph\.p/,
    );
    assert.match(sql, /\(VALUES \(0, 600\), \(1, 30000\)\)/);
    assert.match(
      sql,
      /FROM inbound_event_log t WHERE t\.source = 'loadtest-emr' AND t\.received_at >= '2026-11-05T08:52:33\.000Z'::timestamptz - interval '5 minutes' AND/,
    );
    // Without bounds: full scans by LIKE.
    assert.match(stage(), /FROM protocol_instance t WHERE \(t\.patient_id LIKE/);
  });

  it('adds the legacy v1 JSONB branch only when legacyV1, without a time bound', () => {
    assert.ok(!/raw_payload|->'subject'/.test(stage()));
    const legacy = stage({
      selectors: ['LOADTEST-1103172520-'],
      legacyV1: true,
      bounds: { floor: '0', runStart: 'x', source: 's' },
    });
    assert.match(legacy, /t\.raw_payload->>'subject' LIKE 'LOADTEST-1103172520-%'/);
    assert.match(legacy, /t\.data->'subject'->>'reference' LIKE 'Patient\/LOADTEST-1103172520-%'/);
    assert.ok(!/::uuid|received_at >=/.test(legacy), 'v1 ids carry no year: no time bound');
  });

  it('stages the LOADTEST facility only with --all', () => {
    assert.ok(!/lt_fac/.test(stage()));
    assert.match(
      stage({ selectors: ['LOADTEST-'], all: true, legacyV1: true }),
      /CREATE TEMP TABLE lt_fac AS SELECT t\.id FROM facility t WHERE t\.facility_id LIKE 'LOADTEST-%'/,
    );
  });

  it('never writes to the never-touched tables', () => {
    const sql = [
      stage({
        selectors: ['LOADTEST-'],
        all: true,
        legacyV1: true,
        schema: schema({ stepGroups: true, delivery: true }),
      }),
    ];
    for (const entry of CLEANUP_TABLES) sql.push(...buildBatchDeleteSql(entry));
    for (const table of NEVER_TOUCHED)
      assert.ok(!sql.join('\n').includes(table), `${table} must never appear`);
  });
});

describe('buildBatchDeleteSql', () => {
  it("is ['BEGIN', 'SET LOCAL lock_timeout …', delete, 'COMMIT']", () => {
    const pi = CLEANUP_TABLES.find((t) => t.table === 'protocol_instance');
    const sql = buildBatchDeleteSql(pi, { batchSize: 10000, lockTimeoutSeconds: 5 });
    assert.equal(sql.length, 4);
    assert.equal(sql[0], 'BEGIN');
    assert.equal(sql[1], "SET LOCAL lock_timeout = '5000ms'");
    assert.equal(
      sql[2],
      'WITH b AS (DELETE FROM lt_pi WHERE id IN (SELECT id FROM lt_pi LIMIT 10000) RETURNING id), d AS (DELETE FROM protocol_instance t USING b WHERE t.id = b.id RETURNING 1) SELECT (SELECT count(*) FROM b)::bigint AS staged, (SELECT count(*) FROM d)::bigint AS deleted',
    );
    assert.equal(sql[3], 'COMMIT');
  });
  it('deletes the step-group tree in one statement (self-referencing parent key)', () => {
    const sgi = CLEANUP_TABLES.find((t) => t.table === 'step_group_instance');
    assert.ok(!/LIMIT/.test(buildBatchDeleteSql(sgi)[2]));
  });
});

describe('buildVerifySql', () => {
  const o = { selectors: SELECTORS, all: false, legacyV1: false, bounds: null, schema: schema() };
  it('snapshot: staged rows that still exist', () => {
    const si = CLEANUP_TABLES.find((t) => t.table === 'step_instance');
    assert.equal(
      buildVerifySql(si, o).snapshotSql,
      'SELECT count(*)::bigint AS n FROM step_instance WHERE id IN (SELECT id FROM lt_si_all)',
    );
  });
  it('predicate: direct selectors on own-selector tables, orphans via lt_pi_all / lt_si_all on children', () => {
    const predicate = (table) =>
      buildVerifySql(
        CLEANUP_TABLES.find((t) => t.table === table),
        o,
      ).predicateSql;
    assert.match(
      predicate('protocol_instance'),
      /t\.patient_id LIKE 'LOADTEST-20261105-142233-col-%'/,
    );
    assert.equal(
      predicate('intelligence_event_log'),
      'SELECT count(*)::bigint AS n FROM intelligence_event_log t WHERE t.protocol_instance_id IN (SELECT id FROM lt_pi_all)',
      'per run: no unindexed subject LIKE',
    );
    assert.match(predicate('matcher_event_log'), /t\.cloudevents_id LIKE/);
    assert.match(
      predicate('step_instance'),
      /t\.protocol_instance_id IN \(SELECT id FROM lt_pi_all\)/,
    );
    assert.match(predicate('protocol_instance_history'), /lt_pi_all/);
    assert.match(
      predicate('step_instance_history'),
      /t\.step_instance_id IN \(SELECT id FROM lt_si_all\)/,
    );
    assert.match(predicate('step_sla_state_transition'), /lt_si_all/);
    assert.match(predicate('deviation'), /lt_si_all/);
  });
});

describe('helpers', () => {
  it('literal() escapes quotes; candidate ids refuse unsafe selectors', () => {
    assert.equal(literal("a'b"), "'a''b'");
    assert.throws(() => candidateIdsSql({ selector: "LOADTEST-x'", phases: [] }));
  });
});

describe('printCleanupSql', () => {
  const environment = localEnvironment();
  const settings = resolveSettings({ environment, env: {} });
  const resultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-print-'));

  it('covers all 13 tables (facility shown as skipped per run) with stage, count, batch and verify SQL', () => {
    const text = printCleanupSql({ environment, scope: { runId: RUN_ID }, settings, resultsRoot });
    for (const { table } of CLEANUP_TABLES) assert.ok(text.includes(table), table);
    for (const section of [
      'Schema detection',
      'Guards',
      'Stage',
      'Before counts',
      'Batched deletes',
      'Verify',
    ])
      assert.match(text, new RegExp(section));
    assert.match(text, /-- 13 facility: skipped \(only with --all/);
    assert.match(text, /CREATE INDEX CONCURRENTLY IF NOT EXISTS loadtest_cleanup_matched_event/);
    assert.ok(!/raw_payload/.test(text), 'no legacy branch for a default run id');
  });

  it('with --all deletes from all 13 tables (optional ones marked conditional)', () => {
    const text = printCleanupSql({ environment, scope: { all: true }, settings, resultsRoot });
    for (const { table } of CLEANUP_TABLES)
      assert.match(text, new RegExp(`DELETE FROM ${table} t USING b`), table);
    assert.match(text, /only if table step_group_instance exists/);
  });

  it('shows the legacy branch and the full-scan note for a v1 run id', () => {
    const text = printCleanupSql({
      environment,
      scope: { runId: '1103172520' },
      settings,
      resultsRoot,
    });
    assert.match(text, /legacy v1 branch ON/);
    assert.match(text, /raw_payload->>'subject' LIKE 'LOADTEST-1103172520-%'/);
    assert.match(text, /full scan: may take minutes/);
  });
});
