/**
 * checks.spec.mjs — every preflight check id of plan §7.1 with its pass, fail and warn outcomes
 *
 * What:    Runs runPreflight against the fake stack (fake-clients.mjs), breaks one thing at a time and checks
 *          the outcome of the check that must notice: environment, docker, service-health.<subject>,
 *          service-metrics.<subject>, postgres, postgres-target, schema-step-groups, kafka,
 *          matcher-consumer-group, plan-definition-set (overlap = the matcher's all-paths rule on the template
 *          the run sends; fails for the matcher, warns for the collector; condition-only triggers warn), disk.results, disk.data-stores (local vs dev), wal-and-slots, autovacuum,
 *          leftover-test-data, step-sla-scheduler, monitoring. A "warn" is either the check's own warning
 *          outcome or a failure of a warning-level check; checks that are always required have no warn
 *          outcome, and the tests pin that their failure is never downgraded.
 * How:     npm test   (or: node --test tools/preflight/unit-tests/checks.spec.mjs)
 * Needs:   test-data/ (A1) for the plan-definition set; fake clients only — nothing connects anywhere.
 * Outputs: node:test results only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { repoPath } from '../../core/paths.mjs';
import { resolveSettings } from '../../core/settings.mjs';
import { CHECK_IDS } from '../checks/index.mjs';
import { healthSubjects } from '../checks/service-health.mjs';
import { runPreflight } from '../preflight.mjs';
import { MODULES, devEnvironment, fakeStack, localEnvironment } from './fake-clients.mjs';

const RESULTS = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-results-'));
const SINGLE = 'http://openphc.org/PlanDefinition/emr-service-protocol|1.0.0';

/**
 * Run a preflight on the fake stack.
 * @param {{subjects?: string[], stack?: object, environment?: object, set?: object, testDataRoot?: string}} [o]
 */
async function run({
  subjects = ['matcher'],
  stack = {},
  environment,
  set = {},
  testDataRoot,
} = {}) {
  const fake = fakeStack({ resultsRoot: RESULTS, environment, ...stack });
  const settings = resolveSettings({ environment: fake.environment, overrides: set, env: {} });
  const result = await runPreflight({
    environment: fake.environment,
    subjects,
    settings,
    clients: fake.clients,
    modules: MODULES,
    resultsRoot: RESULTS,
    ...(testDataRoot ? { testDataRoot } : {}),
    now: () => new Date('2026-11-06T10:00:00Z'),
  });
  const check = (id) => {
    const found = result.checks.find((c) => c.id === id);
    assert.ok(found, `check ${id} missing; have ${result.checks.map((c) => c.id).join(', ')}`);
    return found;
  };
  return { result, calls: fake.calls, check };
}

/** Assert status (and optionally severity) of one check. */
function expectCheck(check, status, severity) {
  assert.equal(check.status, status, `${check.id}: ${check.detail}`);
  if (severity) assert.equal(check.severity, severity, `${check.id} severity`);
}

describe('healthy stack', () => {
  it('passes every check a matcher run needs (all ids of plan §7.1 present)', async () => {
    const { result, check } = await run({ subjects: ['matcher'] });
    const notPassed = result.checks.filter((c) => c.status !== 'pass' && c.status !== 'skip');
    assert.deepEqual(notPassed, []);
    assert.equal(result.status, 'passed');
    for (const id of CHECK_IDS.filter((x) => !x.includes('<'))) check(id);
    expectCheck(check('service-health.matcher'), 'pass', 'required');
    expectCheck(check('service-metrics.matcher'), 'pass', 'required');
    expectCheck(check('step-sla-scheduler'), 'skip'); // not needed for a matcher run
  });
});

describe('environment', () => {
  it('pass: local, password variable set', async () =>
    expectCheck((await run()).check('environment'), 'pass', 'required'));
  it('fail: DB password variable missing (always required: never downgraded to warn)', async () => {
    const { check, result } = await run({ stack: { env: {} } });
    expectCheck(check('environment'), 'fail', 'required');
    assert.match(check('environment').detail, /DB_PASSWORD is not set/);
    assert.equal(result.status, 'failed');
  });
});

describe('docker', () => {
  it('pass: daemon and k6 image present', async () =>
    expectCheck((await run()).check('docker'), 'pass', 'required'));
  it('fail: k6 image missing for a k6 test', async () => {
    const { check } = await run({ stack: { exec: { imageInspect: 1 } } });
    expectCheck(check('docker'), 'fail', 'required');
    assert.match(check('docker').detail, /build-k6-image/);
  });
  it('warn: docker down during a stack check (no k6 test named)', async () => {
    expectCheck(
      (await run({ subjects: [], stack: { exec: { dockerVersion: 1 } } })).check('docker'),
      'warn',
      'warning',
    );
  });
  it('skip: Step SLA (seeded) runs need no k6', async () =>
    expectCheck((await run({ subjects: ['step-sla'] })).check('docker'), 'skip'));
});

describe('service-health.<subject>', () => {
  it('pass, and /actuator/health is called once per service (collector health opens a Kafka AdminClient)', async () => {
    const { check, calls } = await run({ subjects: ['collector'] });
    expectCheck(check('service-health.collector'), 'pass', 'required');
    expectCheck(check('service-health.protocol'), 'pass', 'required');
    const healthCalls = calls.http.filter((c) => c.url.endsWith('/actuator/health'));
    assert.deepEqual(healthCalls.map((c) => c.url).sort(), [
      'http://localhost:8093/actuator/health',
      'http://localhost:8096/actuator/health',
    ]);
  });
  it('fail: DOWN, naming the DOWN components (always required)', async () => {
    const { check } = await run({
      stack: {
        health: {
          matcher: {
            status: 'DOWN',
            components: { db: { status: 'DOWN' }, ping: { status: 'UP' } },
          },
        },
      },
    });
    expectCheck(check('service-health.matcher'), 'fail', 'required');
    assert.match(check('service-health.matcher').detail, /DOWN \(db=DOWN\)/);
  });
  it('fail: not answering', async () => {
    const { check } = await run({
      subjects: ['step-sla'],
      stack: { health: { 'step-sla': new Error('ECONNREFUSED') } },
    });
    expectCheck(check('service-health.step-sla'), 'fail', 'required');
  });
  it('ids carry the subject spelling (step-sla, not stepSla)', async () => {
    const { result } = await run({ subjects: [] });
    const ids = result.checks.map((c) => c.id);
    for (const id of [
      'service-health.collector',
      'service-health.matcher',
      'service-health.step-sla',
      'service-health.protocol',
    ])
      assert.ok(ids.includes(id), id);
  });
  it("subjects come from the modules' requires.services, so a later adaptor module is checked too", () => {
    const environment = {
      services: { collector: { baseUrl: 'http://c' }, stepSla: { baseUrl: 'http://s' } },
      adaptors: { 'tiberbu-adaptor': { baseUrl: 'http://t' } },
    };
    const adaptorRun = {
      environment,
      stackCheck: false,
      planDefinitionSetName: null,
      subjects: [
        { subject: 'tiberbu-adaptor', requires: { services: ['tiberbu-adaptor', 'collector'] } },
      ],
    };
    assert.deepEqual(healthSubjects(adaptorRun), ['collector', 'tiberbu-adaptor']);
    // A stack check covers every configured service and adaptor (subject spelling step-sla, not stepSla).
    assert.deepEqual(healthSubjects({ environment, stackCheck: true, subjects: [] }), [
      'collector',
      'step-sla',
      'tiberbu-adaptor',
    ]);
  });
});

describe('service-metrics.<subject>', () => {
  it('pass: key metric present', async () =>
    expectCheck((await run()).check('service-metrics.matcher'), 'pass', 'required'));
  it('fail: matcher metric missing (required for the matcher)', async () => {
    const { check } = await run({ stack: { metrics: { matcher: {} } } });
    expectCheck(check('service-metrics.matcher'), 'fail', 'required');
    assert.match(check('service-metrics.matcher').detail, /cce_events_processed_total missing/);
  });
  it('warn: collector metric missing (warning for the collector)', async () => {
    expectCheck(
      (
        await run({
          subjects: ['collector'],
          stack: { metrics: { collector: new Error('timeout') } },
        })
      ).check('service-metrics.collector'),
      'warn',
      'warning',
    );
  });
});

describe('postgres', () => {
  it('pass: SELECT 1 answers', async () =>
    expectCheck((await run()).check('postgres'), 'pass', 'required'));
  it('fail: cannot connect (always required)', async () => {
    const { check } = await run({
      stack: {
        db: { select1: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) },
      },
    });
    expectCheck(check('postgres'), 'fail', 'required');
  });
  it('fail: no database client because the password is missing', async () => {
    expectCheck((await run({ stack: { noDb: true } })).check('postgres'), 'fail', 'required');
  });
});

describe('postgres-target', () => {
  it('pass: ccedb with the expected tables', async () =>
    expectCheck((await run()).check('postgres-target'), 'pass', 'required'));
  it('fail: another database on that port (lesson: two DBs on one port)', async () => {
    const { check } = await run({
      stack: { db: { target: () => [{ database: 'otherdb', server_port: 5432, version: 'x' }] } },
    });
    expectCheck(check('postgres-target'), 'fail', 'required');
  });
  it('fail: expected tables missing', async () => {
    const { check } = await run({
      stack: { db: { tables: () => [{ table_name: 'inbound_event_log' }] } },
    });
    expectCheck(check('postgres-target'), 'fail');
    assert.match(check('postgres-target').detail, /matcher_event_log/);
  });
});

describe('schema-step-groups', () => {
  it('pass: table and column exist', async () =>
    expectCheck((await run()).check('schema-step-groups'), 'pass'));
  it('fail: missing for a Step SLA run (required)', async () => {
    const stack = { db: { stepGroups: () => [{ has_table: true, has_column: false }] } };
    expectCheck(
      (await run({ subjects: ['step-sla'], stack })).check('schema-step-groups'),
      'fail',
      'required',
    );
  });
  it('warn: missing for a matcher run (warning)', async () => {
    const stack = { db: { stepGroups: () => [{ has_table: false, has_column: false }] } };
    expectCheck(
      (await run({ subjects: ['matcher'], stack })).check('schema-step-groups'),
      'warn',
      'warning',
    );
  });
});

describe('kafka', () => {
  it('pass: topic with the expected 25 partitions', async () =>
    expectCheck((await run()).check('kafka'), 'pass', 'required'));
  it('fail: inbound topic missing (matcher)', async () => {
    expectCheck(
      (await run({ stack: { kafka: { topics: [] } } })).check('kafka'),
      'fail',
      'required',
    );
  });
  it('warn: partition count differs', async () => {
    const { check } = await run({ stack: { kafka: { partitions: 3 } } });
    expectCheck(check('kafka'), 'warn');
    assert.match(check('kafka').detail, /3 partitions, expected 25/);
  });
  it('warn: topic missing for the collector (warning there)', async () => {
    expectCheck(
      (await run({ subjects: ['collector'], stack: { kafka: { topics: [] } } })).check('kafka'),
      'warn',
      'warning',
    );
  });
  it('skip: Step SLA does not need Kafka', async () =>
    expectCheck((await run({ subjects: ['step-sla'] })).check('kafka'), 'skip'));
});

describe('matcher-consumer-group', () => {
  it('pass: Stable, members, all partitions assigned', async () =>
    expectCheck((await run()).check('matcher-consumer-group'), 'pass', 'required'));
  it('fail: group not Stable (matcher)', async () => {
    const stack = { kafka: { group: { state: 'Empty', members: 0, assignedPartitions: 0 } } };
    expectCheck((await run({ stack })).check('matcher-consumer-group'), 'fail', 'required');
  });
  it('fail: partitions not all assigned', async () => {
    const stack = { kafka: { group: { state: 'Stable', members: 1, assignedPartitions: 20 } } };
    assert.match((await run({ stack })).check('matcher-consumer-group').detail, /20 of 25/);
  });
  it('warn: no members during a collector run (warning there)', async () => {
    const stack = { kafka: { group: { state: 'Stable', members: 0, assignedPartitions: 0 } } };
    expectCheck(
      (await run({ subjects: ['collector'], stack })).check('matcher-consumer-group'),
      'warn',
      'warning',
    );
  });
});

describe('plan-definition-set', () => {
  const other = [{ id: 'o1', url: 'http://real/other', version: '2.0.0', status: 'ACTIVE' }];

  it('pass: set ACTIVE, no other ACTIVE definition matches; effectiveFanOut = fan-out', async () => {
    const { check, calls } = await run();
    const c = check('plan-definition-set');
    expectCheck(c, 'pass', 'required');
    assert.equal(c.data.effectiveFanOut, 1);
    assert.deepEqual(c.data.otherActivePlanDefinitions, []);
    // The overlap query is read-only, bounded, and carries the '' resource-type-only row.
    const overlap = calls.db.find((q) => /FROM trigger_index/.test(q.sql));
    assert.match(overlap.sql, /^WITH e AS/);
    // The matcher's Tier 1 rule: every path|system of an action must be hit by ONE event.
    assert.match(overlap.sql, /GROUP BY e\.event_no, ti\.protocol_definition_id, ti\.action_id/);
    assert.match(overlap.sql, /count\(DISTINCT t2\.path \|\| '\|' \|\| t2\.code_system\)/);
    assert.equal(overlap.options.statementTimeoutMs, 5000);
    const rows = overlap.params[0].map((eventNo, i) => [
      eventNo,
      overlap.params[1][i],
      overlap.params[2][i],
      overlap.params[3][i],
      overlap.params[4][i],
    ]);
    assert.ok(
      rows.some(
        ([n, type, p, s, v]) => n === 0 && type === 'Encounter' && p === '' && s === '' && v === '',
      ),
    );
    assert.ok(
      rows.some(
        ([, type, p, , v]) => type === 'Encounter' && p === 'type' && v === 'VISIT_ENCOUNTER',
      ),
    );
    // Only the template the run sends (EVENT_ACTION_ID default = visit-encounter): one event, no
    // tuples from other templates (e.g. the lab Observation) and none from the set's trigger rows.
    assert.deepEqual(new Set(overlap.params[0]), new Set([0]));
    assert.deepEqual(new Set(overlap.params[1]), new Set(['Encounter']));
    assert.deepEqual(c.data.eventTemplates, ['visit-encounter']);
    assert.deepEqual(overlap.params[5], [SINGLE]);
    const conditionOnly = calls.db.find((q) => /jsonb_path_exists/.test(q.sql));
    assert.deepEqual(conditionOnly.params, [[SINGLE]]);
  });

  it('EVENT_ACTION_ID picks the template whose codes are matched', async () => {
    const { calls } = await run({ set: { EVENT_ACTION_ID: 'lab-order' } });
    const overlap = calls.db.find((q) => /FROM trigger_index/.test(q.sql));
    assert.ok(!overlap.params[1].includes('Encounter'), 'the visit template is not sent');
  });

  it('warn (not counted) for another ACTIVE definition with a condition-only trigger', async () => {
    const { check, result } = await run({
      subjects: ['matcher'],
      stack: {
        db: {
          conditionOnly: () => [
            { id: 'c1', url: 'http://real/tier2', version: '1.0.0', status: 'ACTIVE' },
          ],
        },
      },
    });
    const c = check('plan-definition-set');
    expectCheck(c, 'warn');
    assert.equal(c.data.effectiveFanOut, 1);
    assert.equal(c.data.otherActivePlanDefinitions[0].matchesDatasetEvents, null);
    assert.match(c.data.otherActivePlanDefinitions[0].note, /condition-only/);
    assert.match(c.detail, /may also match/);
    assert.notEqual(result.status, 'failed');
  });

  it('warn: dataset not found ("overlap not measured")', async () => {
    const { check } = await run({ set: { DATASET: 'no-such-dataset' } });
    expectCheck(check('plan-definition-set'), 'warn');
    assert.match(
      check('plan-definition-set').detail,
      /overlap not measured \(dataset no-such-dataset not found\)/,
    );
  });

  it('fail: a definition of the set is missing', async () => {
    const { check } = await run({ stack: { protocol: { [SINGLE]: null } } });
    expectCheck(check('plan-definition-set'), 'fail', 'required');
    assert.match(check('plan-definition-set').detail, /MISSING: run plan-definitions load/);
  });

  it('fail for the matcher when another ACTIVE definition matches the dataset events', async () => {
    const { check, result } = await run({
      subjects: ['matcher'],
      stack: { db: { overlap: () => other } },
    });
    const c = check('plan-definition-set');
    expectCheck(c, 'fail', 'required');
    assert.equal(c.data.effectiveFanOut, 2);
    assert.deepEqual(c.data.otherActivePlanDefinitions, [
      {
        id: 'o1',
        canonical: 'http://real/other|2.0.0',
        status: 'ACTIVE',
        matchesDatasetEvents: true,
        note: null,
      },
    ]);
    assert.equal(result.status, 'failed');
  });

  it('warn for the matcher with ALLOW_OTHER_ACTIVE_PLAN_DEFINITIONS=true', async () => {
    const { check } = await run({
      stack: { db: { overlap: () => other } },
      set: { ALLOW_OTHER_ACTIVE_PLAN_DEFINITIONS: 'true' },
    });
    expectCheck(check('plan-definition-set'), 'warn');
  });

  it('warn (not fail) for the collector and Step SLA', async () => {
    for (const subject of ['collector', 'step-sla']) {
      const { check, result } = await run({
        subjects: [subject],
        stack: { db: { overlap: () => other } },
      });
      expectCheck(check('plan-definition-set'), 'warn');
      assert.equal(check('plan-definition-set').data.effectiveFanOut, 2);
      assert.notEqual(result.status, 'failed');
    }
  });

  it('fail regardless for an exclusive set, even for the collector', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-test-data-'));
    fs.mkdirSync(path.join(root, 'plan-definition-sets', 'only-mine'), { recursive: true });
    // The overlap is measured from the dataset's templates, so the temporary root needs the dataset too.
    fs.cpSync(repoPath('test-data', 'datasets'), path.join(root, 'datasets'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'plan-definition-sets', 'only-mine', 'set.json'),
      JSON.stringify({
        name: 'only-mine',
        exclusive: true,
        // DATASET empty: the overlap is measured with the set's first compatible dataset.
        compatibleDatasets: ['ebuzima-emr'],
        planDefinitions: [
          { file: repoPath('test-data', 'plan-definitions', 'emr-service-protocol.json') },
        ],
      }),
    );
    const { check } = await run({
      subjects: ['collector'],
      stack: { db: { overlap: () => other } },
      set: { PLAN_DEFINITION_SET: 'only-mine', ALLOW_OTHER_ACTIVE_PLAN_DEFINITIONS: 'true' },
      testDataRoot: root,
    });
    expectCheck(check('plan-definition-set'), 'fail');
    assert.match(check('plan-definition-set').detail, /exclusive/);
  });

  it('warn: overlap query timed out ("not measured")', async () => {
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    const { check } = await run({ stack: { db: { overlap: timeout } } });
    expectCheck(check('plan-definition-set'), 'warn');
    assert.match(check('plan-definition-set').detail, /not measured/);
  });
});

describe('disk.results', () => {
  it('pass: enough free space', async () =>
    expectCheck((await run()).check('disk.results'), 'pass', 'required'));
  it('fail: below MIN_FREE_DISK_GB (always required)', async () => {
    const { check } = await run({ stack: { freeGb: { results: 5 } } });
    expectCheck(check('disk.results'), 'fail', 'required');
    assert.match(check('disk.results').detail, /only 5 GB free/);
  });
  it('pass: an explicit MIN_FREE_DISK_GB lowers the limit', async () => {
    expectCheck(
      (await run({ stack: { freeGb: { results: 5 } }, set: { MIN_FREE_DISK_GB: '2' } })).check(
        'disk.results',
      ),
      'pass',
    );
  });
});

describe('disk.data-stores', () => {
  it('local pass: Docker data root (docker info) has room', async () => {
    const { check, calls } = await run();
    expectCheck(check('disk.data-stores'), 'pass', 'required');
    assert.ok(calls.exec.includes('docker info --format {{.DockerRootDir}}'));
    assert.equal(check('disk.data-stores').data.dataStoresSource, 'docker-root');
  });
  it('local fail: Docker data root nearly full', async () => {
    expectCheck(
      (await run({ stack: { freeGb: { docker: 3 } } })).check('disk.data-stores'),
      'fail',
      'required',
    );
  });
  it('dev warn: remote stores, reports DB/WAL/Kafka sizes instead of free space', async () => {
    const environment = devEnvironment();
    const { check, calls } = await run({
      environment,
      stack: { kafka: { describeLogDirs: async () => 3 * 1024 ** 3 } },
    });
    const c = check('disk.data-stores');
    expectCheck(c, 'warn', 'warning');
    assert.equal(c.data.dbSizeBytes, 2 * 1024 ** 3);
    assert.equal(c.data.kafkaLogBytes, 3 * 1024 ** 3);
    assert.equal(c.data.dataStoresSource, 'not-measurable');
    assert.ok(
      !calls.exec.some((x) => x.startsWith('docker info')),
      'no docker info for remote stores',
    );
  });
  it('dev warn: WAL size not measurable without pg_monitor is a note, not an error', async () => {
    const { check } = await run({
      environment: devEnvironment(),
      stack: { db: { walSize: new Error('permission denied for function pg_ls_waldir') } },
    });
    expectCheck(check('disk.data-stores'), 'warn');
    assert.match(check('disk.data-stores').detail, /WAL not measurable/);
  });
});

describe('wal-and-slots', () => {
  it('pass: slot reserved with headroom', async () =>
    expectCheck((await run()).check('wal-and-slots'), 'pass', 'warning'));
  it('warn: slot lost (warning-only check: never fails the run)', async () => {
    const stack = {
      db: {
        slots: () => [
          {
            slot_name: 'cce_analytics_slot',
            active: false,
            wal_status: 'lost',
            safe_wal_size: null,
            lag_bytes: null,
          },
        ],
      },
    };
    const { check, result } = await run({ stack });
    expectCheck(check('wal-and-slots'), 'warn', 'warning');
    assert.match(check('wal-and-slots').detail, /is lost/);
    assert.equal(result.status, 'passed-with-warnings');
  });
  it('warn: safe_wal_size below CLEANUP_MIN_SAFE_WAL_GB', async () => {
    const stack = {
      db: {
        slots: () => [
          {
            slot_name: 's',
            active: true,
            wal_status: 'reserved',
            safe_wal_size: 1024 ** 3,
            lag_bytes: 0,
          },
        ],
      },
    };
    assert.match((await run({ stack })).check('wal-and-slots').detail, /1\.0 GB of WAL headroom/);
  });
});

describe('autovacuum', () => {
  it('pass: no vacuum, few dead rows', async () =>
    expectCheck((await run()).check('autovacuum'), 'pass', 'warning'));
  it('warn: vacuum running and many dead rows (lesson: 666 ms after cleanup)', async () => {
    const stack = {
      db: {
        vacuumRunning: () => [{ running: 1 }],
        deadRows: () => [{ relname: 'step_instance', n_live_tup: 100, n_dead_tup: 900 }],
      },
    };
    const { check } = await run({ stack });
    expectCheck(check('autovacuum'), 'warn');
    assert.match(
      check('autovacuum').detail,
      /1 vacuum\(s\) running; dead rows > 10 % on step_instance \(90 %\)/,
    );
  });
});

describe('leftover-test-data', () => {
  it('pass: nothing left, both cheap queries bounded by 5 s', async () => {
    const { check, calls } = await run();
    expectCheck(check('leftover-test-data'), 'pass', 'warning');
    const probes = calls.db.filter((q) => /AS found|AS first_ring/.test(q.sql));
    assert.equal(probes.length, 2);
    for (const probe of probes) assert.equal(probe.options.statementTimeoutMs, 5000);
    // (a) is UUIDv7-bounded: the floor is 7 days before "now".
    assert.match(probes[0].params[0], /^[0-9a-f]{8}-[0-9a-f]{4}-7000-8000-000000000000$/);
  });
  it('warn: recent LOADTEST data and due LOADTEST alarms', async () => {
    const stack = {
      db: {
        recentTestData: () => [{ found: true }],
        dueAlarms: () => [{ due: 42, first_ring: '2026-11-06T11:00:00Z' }],
      },
    };
    const { check } = await run({ stack });
    expectCheck(check('leftover-test-data'), 'warn');
    assert.match(check('leftover-test-data').detail, /run cleanup.*42 LOADTEST alarm/);
  });
  it('warn: a timed-out probe is "not measured", never a hang or a failure', async () => {
    const timeout = Object.assign(new Error('statement timeout'), { code: '57014' });
    const { check } = await run({ stack: { db: { dueAlarms: timeout } } });
    expectCheck(check('leftover-test-data'), 'warn');
    assert.match(check('leftover-test-data').detail, /not measured \(timeout\): due alarms/);
  });
});

describe('step-sla-scheduler', () => {
  it('pass: cycles increase over poll interval + 2 s', async () => {
    const { check, calls } = await run({ subjects: ['step-sla'] });
    expectCheck(check('step-sla-scheduler'), 'pass', 'required');
    assert.deepEqual(calls.sleep, [7000]);
  });
  it('fail: no cycle for a Step SLA run (scheduler stopped)', async () => {
    expectCheck(
      (await run({ subjects: ['step-sla'], stack: { cycles: [10, 10] } })).check(
        'step-sla-scheduler',
      ),
      'fail',
      'required',
    );
  });
  it('warn: no cycle during a stack check', async () => {
    expectCheck(
      (await run({ subjects: [], stack: { cycles: [10, 10] } })).check('step-sla-scheduler'),
      'warn',
      'warning',
    );
  });
});

describe('monitoring', () => {
  it('pass: Prometheus ready, remote write answers 400 to an empty body, Grafana healthy, token present', async () => {
    expectCheck((await run()).check('monitoring'), 'pass', 'warning');
  });
  it('warn: Prometheus down while MONITORING_REQUIRED=false', async () => {
    expectCheck(
      (await run({ stack: { http: { '/-/ready': null } } })).check('monitoring'),
      'warn',
      'warning',
    );
  });
  it('fail: Prometheus down with MONITORING_REQUIRED=true', async () => {
    const { check } = await run({
      stack: { http: { '/-/ready': null } },
      set: { MONITORING_REQUIRED: 'true' },
    });
    expectCheck(check('monitoring'), 'fail', 'required');
  });
  it('fail: remote-write receiver disabled (404) is named', async () => {
    const { check } = await run({
      stack: { http: { '/api/v1/write': 404 } },
      set: { MONITORING_REQUIRED: 'true' },
    });
    assert.match(check('monitoring').detail, /remote-write receiver disabled/);
  });
  it('warn: reachable but no annotation auth (token or admin password)', async () => {
    const { check } = await run({ stack: { env: { DB_PASSWORD: 'x' } } });
    expectCheck(check('monitoring'), 'warn');
    assert.match(check('monitoring').detail, /GRAFANA_API_TOKEN/);
  });
  it('skip: monitoring disabled in the environment', async () => {
    const environment = localEnvironment({ monitoring: { enabled: false } });
    expectCheck((await run({ environment })).check('monitoring'), 'skip');
  });
});
