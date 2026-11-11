/**
 * sql-conditions-registry.spec.mjs — unit tests of run-sql.mjs, conditions.mjs and service-registry.mjs.
 *
 * What:    Candidate event ids generated from the phase plan (one generate_series per phase), UUIDv7 bounds,
 *          the data-volume SQL of plan §6.8; conditions captured with a fake pool, fake git and a fake A3
 *          active.mjs (and a warning when it is absent); the registry finding the stub module one level deep.
 * How:     node --test tools/core/unit-tests/sql-conditions-registry.spec.mjs
 * Needs:   tools/core/unit-tests/fixtures/stub-service/service-module.mjs.
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { captureConditions, readGitState, snapshotPlanDefinitionSet } from '../conditions.mjs';
import { RefusedError } from '../errors.mjs';
import { buildPhasePlan } from '../lib-bridge.mjs';
import {
  DATA_VOLUME_SQL,
  candidateEventIdsSql,
  candidatePhasePlan,
  runTimedQuery,
  uuidV7LowerBound,
} from '../run-sql.mjs';
import {
  getServiceModule,
  listServiceModules,
  validateServiceModule,
} from '../service-registry.mjs';
import { defaultValues, localEnvironment, tempDir } from './helpers.mjs';

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;

test('candidateEventIdsSql: one generate_series per phase over 0 … plannedEvents-1', () => {
  const phasePlan = buildPhasePlan({
    testType: 'load',
    settings: defaultValues({ LOAD_EVENTS: '1000' }),
    breakpointKind: 'staircase',
  });
  const sql = candidateEventIdsSql({ selector: 'LOADTEST-20261105-142233-col-', phasePlan });
  assert.match(
    sql,
    /'LOADTEST-20261105-142233-col-0-' \|\| n \|\| '-1' AS id FROM generate_series\(0, 599\)/,
  );
  assert.match(
    sql,
    /'LOADTEST-20261105-142233-col-1-' \|\| n \|\| '-1' AS id FROM generate_series\(0, 999\)/,
  );
  assert.equal(sql.split('UNION ALL').length, 2);
  assert.throws(
    () => candidateEventIdsSql({ selector: "x'; DROP TABLE y; --", phasePlan }),
    /Unsafe selector/,
  );
});

test('candidatePhasePlan adds 1 % + 10 per sending phase (one rule for data checks and cleanup)', () => {
  assert.deepEqual(
    candidatePhasePlan({
      phases: [{ plannedEvents: 600 }, { plannedEvents: 0 }, { plannedEvents: 30000 }],
    }),
    { phases: [{ plannedEvents: 616 }, { plannedEvents: 0 }, { plannedEvents: 30310 }] },
  );
});

test('uuidV7LowerBound is the run start minus 5 minutes; data volume reads statistics only', () => {
  assert.equal(uuidV7LowerBound(new Date(300_000)), '00000000-0000-7000-8000-000000000000');
  assert.match(DATA_VOLUME_SQL, /pg_stat_user_tables/);
  assert.doesNotMatch(DATA_VOLUME_SQL, /count\(\*\)/);
  for (const table of ['inbound_event_log', 'deviation', 'protocol_instance_history'])
    assert.match(DATA_VOLUME_SQL, new RegExp(table));
});

test('runTimedQuery runs with a statement timeout and records the duration', async () => {
  const log = [];
  const client = { query: async (sql) => (log.push(sql), { rows: [{ n: 1 }] }), release() {} };
  const out = await runTimedQuery(
    { connect: async () => client },
    { sql: 'SELECT 1', timeoutMs: 1000 },
  );
  assert.deepEqual(out.rows, [{ n: 1 }]);
  assert.equal(typeof out.durationMs, 'number');
  assert.ok(log.includes('SET LOCAL statement_timeout = 1000'));
});

test('readGitState uses read-only git and tolerates a missing git', async () => {
  const commands = [];
  const run = async (cmd, args) => (
    commands.push([cmd, ...args].join(' ')),
    { stdout: args[0] === 'rev-parse' ? 'abc1234\n' : ' M x\n' }
  );
  assert.deepEqual(await readGitState({ run }), { gitCommit: 'abc1234', gitDirty: true });
  assert.deepEqual(commands, ['git rev-parse --short HEAD', 'git status --porcelain']);
  assert.deepEqual(
    await readGitState({
      run: async () => {
        throw new Error('no git');
      },
    }),
    { gitCommit: null, gitDirty: null },
  );
});

const SET = {
  name: 'overlapping-2',
  fanOut: 2,
  planDefinitions: [
    {
      name: 'A',
      url: 'http://x/a',
      version: '1',
      canonical: 'http://x/a|1',
      mandatorySteps: ['s1'],
    },
    {
      name: 'B',
      url: 'http://x/b',
      version: '1',
      canonical: 'http://x/b|1',
      mandatorySteps: ['s1', 's2'],
    },
  ],
};

test('snapshot: statuses from ACTIVE list, other ACTIVE ones, effective fan-out', () => {
  const active = [
    {
      id: 'id-a',
      url: 'http://x/a',
      version: '1',
      canonical: 'http://x/a|1',
      status: 'ACTIVE',
      updatedAt: 't',
    },
    { id: 'id-z', url: 'http://x/z', version: '2', canonical: 'http://x/z|2', status: 'ACTIVE' },
  ];
  const snapshot = snapshotPlanDefinitionSet(SET, active, {
    otherMatches: [{ canonical: 'http://x/z|2', matchesDatasetEvents: true }],
    stepSlaSeedMode: 'set',
  });
  assert.deepEqual(
    snapshot.planDefinitions.map((pd) => [pd.canonical, pd.status, pd.id]),
    [
      ['http://x/a|1', 'ACTIVE', 'id-a'],
      ['http://x/b|1', 'missing', null],
    ],
  );
  assert.deepEqual(snapshot.otherActivePlanDefinitions, [
    { canonical: 'http://x/z|2', status: 'ACTIVE', matchesDatasetEvents: true, note: null },
  ]);
  assert.equal(snapshot.effectiveFanOut, 3);
  assert.equal(snapshot.stepSlaSeedMode, 'set');
});

test('captureConditions: host, git, data volume (fake pool) and the set snapshot via a fake active.mjs', async () => {
  const environment = localEnvironment();
  const pool = {
    connect: async () => ({
      query: async (sql) => ({
        rows: sql.includes('pg_database_size')
          ? [{ db_size_bytes: '1610612736', rows: { step_instance: 5 } }]
          : [],
      }),
      release() {},
    }),
  };
  const warnings = [];
  const conditions = await captureConditions({
    environment,
    settings: defaultValues(),
    planDefinitionSet: SET,
    pgPool: pool,
    protocolApi: {},
    subject: 'matcher',
    warnings,
    deps: {
      readGit: async () => ({ gitCommit: 'abc1234', gitDirty: false }),
      importActive: async () => ({
        getActivePlanDefinitions: async () => [
          { id: 'id-a', canonical: 'http://x/a|1', status: 'ACTIVE' },
        ],
      }),
    },
  });
  assert.equal(conditions.environment.configFile, 'config/environments/local.json');
  assert.equal(conditions.environment.serviceUrls.stepSla, 'http://localhost:8099');
  assert.equal(conditions.host.k6Image, 'cce-load-tests/k6:2.3.0-kafka2.2.0');
  assert.equal(typeof conditions.host.cpus, 'number');
  assert.equal(conditions.suite.gitCommit, 'abc1234');
  assert.equal(conditions.dataVolume.dbSizeBytes, 1610612736);
  assert.equal(conditions.planDefinitionSet.planDefinitions[0].status, 'ACTIVE');
  assert.equal(conditions.planDefinitionSet.stepSlaSeedMode, null, 'only recorded for step-sla');
  assert.deepEqual(warnings, []);
});

test('captureConditions tolerates the absence of A3 active.mjs (warning) and of a database', async () => {
  const warnings = [];
  const conditions = await captureConditions({
    environment: localEnvironment(),
    settings: defaultValues(),
    planDefinitionSet: SET,
    protocolApi: {},
    warnings,
    deps: {
      readGit: async () => ({ gitCommit: null, gitDirty: null }),
      importActive: async () => null,
    },
  });
  assert.equal(conditions.dataVolume, null);
  assert.equal(
    conditions.planDefinitionSet.planDefinitions[0].status,
    null,
    'status unknown, not "missing"',
  );
  assert.match(warnings[0], /active\.mjs not available/);
});

test('service registry: finds the stub one level deep, by subject or service name, with its folder', async () => {
  const modules = await listServiceModules({ root: FIXTURES });
  assert.deepEqual(
    modules.map((m) => m.subject),
    ['stub'],
  );
  const stub = await getServiceModule('stub', { root: FIXTURES });
  assert.equal(stub.idCode, 'stb');
  assert.equal(stub.breakpointKind, 'staircase');
  assert.ok(stub.folder.endsWith(path.join('fixtures', 'stub-service')));
  assert.equal((await getServiceModule('stub-service', { root: FIXTURES })).subject, 'stub');
  await assert.rejects(getServiceModule('collector', { root: FIXTURES }), RefusedError);
});

test('service registry skips archive/, node_modules/ and results/, and rejects malformed modules', async () => {
  const root = tempDir();
  for (const skipped of ['archive', 'node_modules', 'results']) {
    fs.mkdirSync(path.join(root, skipped), { recursive: true });
    fs.writeFileSync(path.join(root, skipped, 'service-module.mjs'), 'export default {};');
  }
  assert.deepEqual(await listServiceModules({ root }), []);
  fs.mkdirSync(path.join(root, 'broken'));
  fs.writeFileSync(
    path.join(root, 'broken', 'service-module.mjs'),
    "export default { subject: 'x' };",
  );
  await assert.rejects(listServiceModules({ root }), /not a valid service module/);
  assert.ok(validateServiceModule({ kind: 'k6' }).includes('k6 modules need testFile()'));
});
