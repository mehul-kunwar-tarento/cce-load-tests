/**
 * preflight.spec.mjs — unit tests of tools/preflight/preflight.mjs and clients.mjs (the runner, not one check)
 *
 * What:    Status rules (required fail → failed; warnings → passed-with-warnings), the printed ✔/✖/!/– table,
 *          preflight.json validating against A2's validatePreflight (plan §5.5), a crashing check turning into
 *          a failed check, the stack check (no subject), and client completion: keys the caller passes are
 *          used as given (a caller's Kafka admin is never disconnected), A2-style getJson/postJson HTTP and a pg
 *          Pool are adapted.
 * How:     npm test   (or: node --test tools/preflight/unit-tests/preflight.spec.mjs)
 * Needs:   Fake clients only (fake-clients.mjs); nothing connects anywhere.
 * Outputs: node:test results only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { validatePreflight } from '../../core/result-schema.mjs';
import { resolveSettings } from '../../core/settings.mjs';
import { adaptHttp, completeClients, dbFromPool } from '../clients.mjs';
import { formatPreflightTable, preflightStatus, runPreflight } from '../preflight.mjs';
import { MODULES, fakeStack } from './fake-clients.mjs';

const RESULTS = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-runner-'));

/** Run on the fake stack and return the result plus the fake's call log. */
async function run(subjects, stackOptions = {}) {
  const fake = fakeStack({ resultsRoot: RESULTS, ...stackOptions });
  const settings = resolveSettings({ environment: fake.environment, env: {} });
  const result = await runPreflight({
    environment: fake.environment,
    subjects,
    settings,
    clients: fake.clients,
    modules: MODULES,
    resultsRoot: RESULTS,
  });
  return { result, calls: fake.calls };
}

describe('preflightStatus', () => {
  it('failed when any check failed, passed-with-warnings with a warn, else passed', () => {
    assert.equal(preflightStatus([{ status: 'pass' }, { status: 'skip' }]), 'passed');
    assert.equal(preflightStatus([{ status: 'pass' }, { status: 'warn' }]), 'passed-with-warnings');
    assert.equal(preflightStatus([{ status: 'warn' }, { status: 'fail' }]), 'failed');
  });
});

describe('runPreflight', () => {
  it('produces a preflight.json that A2 validatePreflight accepts (plan §5.5)', async () => {
    for (const stack of [
      {},
      { health: { matcher: { status: 'DOWN' } } },
      { db: { vacuumRunning: () => [{ running: 2 }] } },
    ]) {
      const { result } = await run(['matcher'], stack);
      assert.deepEqual(
        validatePreflight(result),
        [],
        JSON.stringify(result.checks.filter((c) => c.status !== 'pass')),
      );
      assert.equal(result.schemaVersion, '1.0.0');
      assert.equal(result.kind, 'cce-preflight');
      assert.equal(result.subject, 'matcher');
      assert.equal(result.planDefinitionSet, 'emr-service');
      for (const check of result.checks) assert.equal(typeof check.durationMs, 'number');
    }
  });

  it('copies every warning as "<id>: <detail>" for result.conditions.preflight.warnings', async () => {
    const { result } = await run(['matcher'], { db: { vacuumRunning: () => [{ running: 1 }] } });
    assert.equal(result.status, 'passed-with-warnings');
    assert.ok(result.warnings.some((w) => w.startsWith('autovacuum: 1 vacuum(s) running')));
  });

  it('turns a crashing check into a failed check with the reason, never a crashed preflight', async () => {
    const { result } = await run(['matcher'], {
      db: { target: new Error('relation does not exist') },
    });
    const check = result.checks.find((c) => c.id === 'postgres-target');
    assert.equal(check.status, 'fail');
    assert.match(check.detail, /relation does not exist/);
    assert.equal(result.status, 'failed');
  });

  it('stack check (no subject): every service of the environment, subject-specific checks as warnings', async () => {
    const { result } = await run([], {
      kafka: { group: { state: 'Empty', members: 0, assignedPartitions: 0 } },
    });
    assert.equal(result.subject, null);
    assert.ok(result.checks.some((c) => c.id === 'service-health.step-sla'));
    const group = result.checks.find((c) => c.id === 'matcher-consumer-group');
    assert.deepEqual([group.severity, group.status], ['warning', 'warn']);
  });

  it("connects the caller's Kafka admin when needed but never disconnects it (the run keeps using it)", async () => {
    const { calls } = await run(['matcher']);
    assert.deepEqual(calls.kafka, ['connect']);
  });
});

describe('formatPreflightTable', () => {
  it('prints ✔ ✖ ! – and the verdict', () => {
    const text = formatPreflightTable({
      environment: 'local',
      subject: 'matcher',
      status: 'failed',
      warnings: ['a: b'],
      checks: [
        { id: 'environment', severity: 'required', status: 'pass', detail: 'local (local)' },
        { id: 'service-health.matcher', severity: 'required', status: 'fail', detail: 'DOWN' },
        { id: 'autovacuum', severity: 'warning', status: 'warn', detail: '1 vacuum(s) running' },
        {
          id: 'step-sla-scheduler',
          severity: 'warning',
          status: 'skip',
          detail: 'not needed for this run',
        },
      ],
    });
    assert.match(text, /✔ environment/);
    assert.match(text, /✖ service-health\.matcher\s+required\s+DOWN/);
    assert.match(text, /! autovacuum/);
    assert.match(text, /– step-sla-scheduler/);
    assert.match(text, /FAILED: a required check did not pass/);
  });
});

describe('completeClients', () => {
  it('uses given keys as they are (null = not available) and builds nothing then', async () => {
    const given = {
      http: { request: async () => ({ status: 200 }) },
      scrapeUrl: async () => new Map(),
      db: null,
      kafkaAdmin: null,
      protocolApi: null,
      exec: async () => ({}),
      statfs: async () => ({}),
      sleep: async () => {},
    };
    const { clients, close } = await completeClients({ name: 'x', kind: 'local' }, given, {
      env: {},
    });
    assert.equal(clients.db, null);
    assert.equal(clients.kafkaAdmin, null);
    assert.equal(clients.http, given.http);
    await close();
  });

  it('adapts A2-style getJson/postJson HTTP clients', async () => {
    const seen = [];
    const http = adaptHttp({
      getJson: async (url) => (seen.push(['GET', url]), { status: 200 }),
      postJson: async (url, body) => (seen.push(['POST', url, body]), { status: 204 }),
    });
    await http.request({ method: 'GET', url: 'u1' });
    await http.request({ method: 'POST', url: 'u2', body: {} });
    assert.deepEqual(seen, [
      ['GET', 'u1'],
      ['POST', 'u2', {}],
    ]);
    assert.throws(() => adaptHttp({}), /request/);
  });

  it("wraps a caller's pg Pool so every check query carries its statement_timeout", async () => {
    const statements = [];
    const client = {
      query: async (sql) => (statements.push(sql), { rows: [{ ok: 1 }] }),
      release: () => statements.push('release'),
    };
    const pool = {
      connect: async () => client,
      query: async () => assert.fail('pool.query must not be used with a timeout'),
    };
    const db = await dbFromPool(pool);
    assert.deepEqual(await db.query('SELECT 1 AS ok', [], { statementTimeoutMs: 5000 }), [
      { ok: 1 },
    ]);
    assert.deepEqual(statements, [
      'BEGIN',
      'SET LOCAL statement_timeout = 5000',
      'SELECT 1 AS ok',
      'COMMIT',
      'release',
    ]);
  });

  it('without a password builds no database client (the environment check reports it)', async () => {
    const environment = { name: 'x', kind: 'local', database: { passwordEnvVar: 'DB_PASSWORD' } };
    const { clients, close } = await completeClients(
      environment,
      { kafkaAdmin: null, http: { request: async () => ({}) } },
      { env: {} },
    );
    assert.equal(clients.db, null);
    assert.equal(clients.protocolApi, null); // no services.protocol in this environment
    await close();
  });
});
