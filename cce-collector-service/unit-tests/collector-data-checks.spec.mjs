/**
 * collector-data-checks.spec.mjs — unit tests of the collector data checks with a fake Postgres and Kafka.
 *
 * What:    Checks, without any database: the SQL selects the run through generated candidate ids joined on
 *          (cloudevents_id, source) with the source bound as $1 (no LIKE), runs under a statement_timeout,
 *          and the four checks compare correctly — equals for a normal run, "between accepted and sent" for
 *          a breakpoint or a run that ended early, rejections and stuck rows, the downstream rows, and the
 *          matcher backlog left (read through the real readMatcherBacklog with a fake Kafka admin).
 * How:     npm test   (or: node --test "cce-collector-service/unit-tests/collector-data-checks.spec.mjs")
 * Needs:   Node 22; ./fixtures/*.json; no network, no database.
 * Outputs: node:test results.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildDownstreamLoggedSql,
  buildInboundStatusSql,
  candidatePhasePlan,
  downstreamBacklogCheck,
  endedEarly,
  readK6Counts,
  runCollectorDataChecks,
  storedEqualsAcceptedCheck,
} from '../data-checks/collector-data-checks.mjs';
import {
  createFakeKafkaAdmin,
  createFakePool,
  FAKE_ENVIRONMENT,
  fixtureSettings,
  parsedMetrics,
  readFixture,
} from './test-helpers.mjs';

/** Answers of the fake database: inbound status counts and matcher_event_log rows (pg returns text). */
function answers({ accepted = '620', rejected = '0', received = '0', logged = '620' } = {}) {
  return (sql) => {
    if (sql.includes('FROM inbound_event_log') || sql.includes('JOIN inbound_event_log'))
      return [
        { accepted, rejected, received, stored: String(Number(accepted) + Number(rejected)) },
      ];
    if (sql.includes('JOIN matcher_event_log')) return [{ logged }];
    return []; // BEGIN, SET LOCAL, COMMIT
  };
}

/** A run ctx for the load fixture (or another test type), with fakes for every client. */
function makeCtx({ testType = 'load', pool, lags = [0], summary, times = {}, extra = {} } = {}) {
  const { values, phasePlan } = fixtureSettings(testType);
  return {
    environment: FAKE_ENVIRONMENT,
    settings: values,
    phasePlan,
    runId: values.RUN_ID,
    selector: `LOADTEST-${values.RUN_ID}-col-`,
    resultsDir: null,
    context: { dataset: { source: 'loadtest-emr' } },
    pgPool: pool ?? createFakePool(answers()),
    kafkaAdmin: createFakeKafkaAdmin(lags),
    scrape: async () => parsedMetrics({ cce_events_matched_total: 10 }),
    times: { sendEndedEarly: false, ...times },
    logger: { info() {}, warn() {} },
    summary: summary ?? readFixture('k6-summary-load-passed.json'),
    ...extra,
  };
}

/** Runs the checks with the ctx's summary injected; returns { checks, byId }. */
async function run(ctx, options = {}) {
  const checks = await runCollectorDataChecks(ctx, { readSummary: (c) => c.summary, ...options });
  return { checks, byId: Object.fromEntries(checks.map((c) => [c.id, c])) };
}

describe('collector data checks: SQL', () => {
  it('generates candidate ids per phase with a margin, never LIKE', () => {
    const { phasePlan } = fixtureSettings('load');
    // warm-up 2/s × 10 s = 20 → 20 + 1 + 10 = 31; measure 10/s × 60 s = 600 → 600 + 6 + 10 = 616.
    assert.deepEqual(candidatePhasePlan(phasePlan).phases, [
      { plannedEvents: 31 },
      { plannedEvents: 616 },
    ]);
  });

  it('binds the source as $1, runs under a statement_timeout and joins on (cloudevents_id, source)', async () => {
    const pool = createFakePool(answers());
    await run(makeCtx({ pool }), { timeoutMs: 1234 });
    const data = pool.statements.filter((s) => /candidates/.test(s.sql));
    assert.equal(data.length, 2);
    for (const { sql, params } of data) {
      assert.deepEqual(params, ['loadtest-emr']);
      assert.doesNotMatch(sql, /LIKE/i);
      assert.match(sql, /generate_series\(0, 30\)/); // warm-up candidates (phase 0)
      assert.match(sql, /generate_series\(0, 615\)/); // measured candidates (phase 1)
      assert.match(sql, /'LOADTEST-fixture01-col-1-' \|\| n \|\| '-1'/);
      assert.match(sql, /cloudevents_id = c\.id AND [im]\.source = \$1/);
    }
    assert.ok(pool.statements.some((s) => s.sql === 'SET LOCAL statement_timeout = 1234'));
    assert.equal(pool.released, 2); // one dedicated client per query, always released
  });

  it('builds the two queries around any candidate SQL', () => {
    const inbound = buildInboundStatusSql('SELECT 1 AS id');
    assert.match(inbound, /FILTER \(WHERE i\.status = 'ACCEPTED'\)/);
    assert.match(inbound, /FILTER \(WHERE i\.status = 'REJECTED'\)/);
    assert.match(buildDownstreamLoggedSql('SELECT 1 AS id'), /JOIN matcher_event_log m/);
  });
});

describe('collector data checks: comparisons', () => {
  it('load: stored ACCEPTED = k6 accepted (all phases) passes; rows carry SQL and duration', async () => {
    const { byId } = await run(makeCtx());
    const stored = byId['collector.stored-equals-accepted'];
    assert.equal(stored.comparison, 'equals');
    assert.equal(stored.expected, 620); // 20 warm-up + 600 measured
    assert.equal(stored.actual, 620);
    assert.equal(stored.passed, true);
    assert.equal(stored.severity, 'required');
    assert.match(stored.sql, /inbound_event_log/);
    assert.equal(typeof stored.durationMs, 'number');
    assert.equal(byId['collector.no-rejections'].passed, true);
  });

  it('load: one event missing from the database fails the required check', async () => {
    const { byId } = await run(makeCtx({ pool: createFakePool(answers({ accepted: '619' })) }));
    assert.equal(byId['collector.stored-equals-accepted'].passed, false);
  });

  it('rejections fail no-rejections; rows stuck in RECEIVED are named', async () => {
    const pool = createFakePool(answers({ rejected: '3', received: '2' }));
    const { byId } = await run(makeCtx({ pool }));
    const check = byId['collector.no-rejections'];
    assert.equal(check.actual, 3);
    assert.equal(check.passed, false);
    assert.match(check.description, /2 rows still RECEIVED/);
  });

  it('breakpoint: between accepted and sent (a cut-off request may still be stored)', async () => {
    const summary = readFixture('k6-summary-breakpoint-broke.json'); // accepted 485, sent 486
    for (const [stored, passed] of [
      ['485', true],
      ['486', true],
      ['484', false],
      ['487', false],
    ]) {
      const pool = createFakePool(answers({ accepted: stored }));
      const { byId } = await run(makeCtx({ testType: 'breakpoint', pool, summary }));
      const check = byId['collector.stored-equals-accepted'];
      assert.equal(check.comparison, 'between');
      assert.deepEqual(check.expected, [485, 486]); // [lower, upper] = [accepted, sent]
      assert.match(check.description, /between 485 .* and 486 \(sent\)/);
      assert.equal(check.passed, passed, `stored ${stored}`);
    }
  });

  it('a load run that ended early (k6 stopped) or was aborted is judged "between" too', async () => {
    const early = await run(makeCtx({ times: { sendEndedEarly: true } }));
    assert.equal(early.byId['collector.stored-equals-accepted'].comparison, 'between');
    assert.equal(
      endedEarly({ phasePlan: { testType: 'load' }, result: { status: 'aborted' } }),
      true,
    );
    assert.equal(endedEarly({ phasePlan: { testType: 'load' }, times: {} }), false);
  });

  it('without a k6 summary the required check fails with a clear reason', () => {
    const check = storedEqualsAcceptedCheck({ storedAccepted: 10, counts: null, early: false });
    assert.equal(check.passed, false);
    assert.equal(check.expected, null);
    assert.match(check.description, /k6-summary\.json missing/);
    assert.equal(readK6Counts(null), null);
  });

  it('downstream-logged is info only (the matcher may still be draining)', async () => {
    const pool = createFakePool(answers({ logged: '600' }));
    const { byId } = await run(makeCtx({ pool }));
    const check = byId['collector.downstream-logged'];
    assert.equal(check.severity, 'info');
    assert.equal(check.expected, 620);
    assert.equal(check.actual, 600);
    assert.equal(check.passed, false);
  });

  it('reads k6-summary.json from the results folder by default', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-checks-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'k6-summary.json'),
        JSON.stringify(readFixture('k6-summary-load-passed.json')),
      );
      const ctx = makeCtx({ extra: { resultsDir: dir } });
      const checks = await runCollectorDataChecks(ctx); // no readSummary injected
      assert.equal(checks[0].expected, 620);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to run without a database pool (DB_PASSWORD not set)', async () => {
    await assert.rejects(run(makeCtx({ extra: { pgPool: null } })), /DB_PASSWORD/);
  });
});

describe('collector data checks: downstream backlog left (info)', () => {
  it('reads the matcher group lag through the real readMatcherBacklog', async () => {
    const ctx = makeCtx({ lags: [42] });
    const { byId } = await run(ctx);
    const check = byId['collector.downstream-backlog-left'];
    assert.deepEqual(ctx.kafkaAdmin.calls[0], {
      groupId: 'cce-matcher-service',
      topic: 'cce.events.inbound',
    });
    assert.equal(check.severity, 'info');
    assert.equal(check.actual, 42);
    assert.equal(check.passed, false);
    assert.match(check.description, /still draining 42 events/);
  });

  it('0 left = the matcher kept up', () => {
    const check = downstreamBacklogCheck({ lag: 0 });
    assert.equal(check.passed, true);
    assert.match(check.description, /kept up/);
  });

  it('an unreadable lag is "not measured" and never fails the run', async () => {
    const ctx = makeCtx();
    ctx.kafkaAdmin = createFakeKafkaAdmin(new Error('broker down'));
    const { byId } = await run(ctx);
    const check = byId['collector.downstream-backlog-left'];
    assert.equal(check.actual, null);
    assert.equal(check.severity, 'info');
    assert.match(check.description, /not measured/);
  });
});
