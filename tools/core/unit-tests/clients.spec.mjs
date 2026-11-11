/**
 * clients.spec.mjs — unit tests of tools/core/clients/*.mjs with fakes only (no connection, D14).
 *
 * What:    postgres: withDedicatedClient always releases (also when the function throws), queryRows wraps a
 *          statement_timeout in BEGIN / SET LOCAL / COMMIT on one client, createPool needs the password env var;
 *          prometheus-text: parsing, exact label filters, null for absent metrics; http-json with a fake fetch;
 *          grafana: auth choice (token, else basic auth, else no-op with ONE warning); kafka-admin lag maths.
 * How:     node --test tools/core/unit-tests/clients.spec.mjs
 * Needs:   Nothing (every network client is replaced by a fake).
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAnnotator, postAnnotation, resolveGrafanaAuth } from '../clients/grafana.mjs';
import { getJson, postJson } from '../clients/http-json.mjs';
import { createKafkaAdmin } from '../clients/kafka-admin.mjs';
import { createPool, queryRows, withDedicatedClient } from '../clients/postgres.mjs';
import { maxMetric, parsePrometheusText, sumMetric } from '../clients/prometheus-text.mjs';
import { localEnvironment } from './helpers.mjs';

const environment = localEnvironment();

/** A fake pg pool whose clients record every statement. */
function fakePool({ failOn = null } = {}) {
  const log = [];
  let released = 0;
  const client = {
    async query(sql) {
      log.push(sql);
      if (failOn && sql.includes(failOn)) throw new Error('boom');
      return { rows: [{ ok: 1 }] };
    },
    release() {
      released += 1;
    },
  };
  return {
    log,
    released: () => released,
    pool: { connect: async () => client, query: client.query },
  };
}

test('withDedicatedClient releases the client in finally, also when fn throws', async () => {
  const fake = fakePool();
  assert.equal(
    await withDedicatedClient(fake.pool, async (c) => (await c.query('SELECT 1')).rows[0].ok),
    1,
  );
  await assert.rejects(
    withDedicatedClient(fake.pool, async () => {
      throw new Error('inside');
    }),
    /inside/,
  );
  assert.equal(fake.released(), 2);
});

test('queryRows with a statement timeout: BEGIN, SET LOCAL, query, COMMIT on one client; ROLLBACK on error', async () => {
  const fake = fakePool();
  assert.deepEqual(await queryRows(fake.pool, 'SELECT x', [], { statementTimeoutMs: 5000 }), [
    { ok: 1 },
  ]);
  assert.deepEqual(fake.log, ['BEGIN', 'SET LOCAL statement_timeout = 5000', 'SELECT x', 'COMMIT']);
  assert.equal(fake.released(), 1);
  const failing = fakePool({ failOn: 'SELECT bad' });
  await assert.rejects(
    queryRows(failing.pool, 'SELECT bad', [], { statementTimeoutMs: 10 }),
    /boom/,
  );
  assert.deepEqual(failing.log, [
    'BEGIN',
    'SET LOCAL statement_timeout = 10',
    'SELECT bad',
    'ROLLBACK',
  ]);
  assert.equal(failing.released(), 1);
  const plain = fakePool();
  await queryRows(plain.pool, 'SELECT y');
  assert.deepEqual(plain.log, ['SELECT y'], 'no timeout → plain pool query');
});

test('createPool reads the password from the named env var and refuses without it', () => {
  let options = null;
  class Pool {
    constructor(o) {
      options = o;
    }
  }
  createPool(environment, { env: { DB_PASSWORD: 'from-env' }, Pool });
  assert.equal(options.password, 'from-env');
  assert.equal(options.port, 15433);
  assert.equal(options.application_name, 'cce-performance-tests');
  assert.throws(() => createPool(environment, { env: {}, Pool }), /DB_PASSWORD/);
});

const METRICS_TEXT = `# HELP hikaricp_connections_pending Pending threads
# TYPE hikaricp_connections_pending gauge
hikaricp_connections_pending{pool="cce-matcher-pool"} 3.0
hikaricp_connections_pending{pool="other"} 1.0
jvm_memory_used_bytes{area="heap",id="G1 Eden Space"} 100.0
jvm_memory_used_bytes{area="heap",id="G1 Old Gen"} 50.0
jvm_memory_used_bytes{area="nonheap",id="Metaspace"} 999.0
jvm_gc_pause_seconds_max{action="end of minor GC",cause="G1 Evacuation Pause"} 0.25
jvm_gc_pause_seconds_max{action="end of major GC",cause="x"} 0.5
http_server_requests_seconds_count{uri="/v1/events",exception="None"} 42 1730000000000
weird_metric NaN
`;

test('prometheus text: sum and max over series, exact label filters, null when absent', () => {
  const parsed = parsePrometheusText(METRICS_TEXT);
  assert.equal(sumMetric(parsed, 'hikaricp_connections_pending'), 4);
  assert.equal(sumMetric(parsed, 'hikaricp_connections_pending', { pool: 'cce-matcher-pool' }), 3);
  assert.equal(sumMetric(parsed, 'jvm_memory_used_bytes', { area: 'heap' }), 150);
  assert.equal(maxMetric(parsed, 'jvm_gc_pause_seconds_max'), 0.5);
  assert.equal(sumMetric(parsed, 'http_server_requests_seconds_count', { uri: '/v1/events' }), 42);
  assert.equal(sumMetric(parsed, 'cce_events_matched_total'), null);
  assert.equal(
    sumMetric(parsed, 'hikaricp_connections_pending', { pool: 'cce-*' }),
    null,
    'no wildcards',
  );
  assert.equal(sumMetric(parsed, 'weird_metric'), null, 'NaN is not a value');
});

test('http-json: JSON body parsed, text kept when not JSON, POST sends JSON', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return {
      status: 200,
      text: async () => (url.endsWith('/html') ? '<html>' : '{"a":1}'),
      headers: null,
    };
  };
  assert.deepEqual((await getJson('http://x/json', { fetchFn })).body, { a: 1 });
  assert.equal((await getJson('http://x/html', { fetchFn })).body, '<html>');
  await postJson('http://x/post', { b: 2 }, { fetchFn });
  assert.equal(calls[2].init.method, 'POST');
  assert.equal(calls[2].init.body, '{"b":2}');
  assert.ok(calls[2].init.signal, 'every request has a timeout signal');
});

test('grafana auth: token first, else user + admin password, else null', () => {
  assert.deepEqual(
    resolveGrafanaAuth(environment, { GRAFANA_API_TOKEN: 't', GRAFANA_ADMIN_PASSWORD: 'p' }),
    { token: 't' },
  );
  assert.deepEqual(resolveGrafanaAuth(environment, { GRAFANA_ADMIN_PASSWORD: 'p' }), {
    user: 'admin',
    password: 'p',
  });
  assert.equal(resolveGrafanaAuth(environment, {}), null);
});

test('grafana annotator: basic auth header, tags; without credentials one warning and no request', async () => {
  const requests = [];
  const fetchFn = async (url, init) => (
    requests.push({ url, init }),
    { status: 200, text: async () => '{}' }
  );
  const basic = createAnnotator({
    environment,
    env: { GRAFANA_ADMIN_PASSWORD: 'pw' },
    fetchFn,
    baseTags: ['r1', 'stub'],
  });
  assert.equal(basic.authKind, 'basic');
  await basic.annotate({ time: 1000, timeEnd: 2000, text: 'run', tags: ['load'] });
  assert.equal(requests[0].url, 'http://localhost:3030/api/annotations');
  assert.equal(
    requests[0].init.headers.authorization,
    `Basic ${Buffer.from('admin:pw').toString('base64')}`,
  );
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    time: 1000,
    timeEnd: 2000,
    tags: ['cce-performance', 'r1', 'stub', 'load'],
    text: 'run',
  });

  const warnings = [];
  const none = createAnnotator({
    environment,
    env: {},
    fetchFn,
    logger: { warn: (m) => warnings.push(m) },
  });
  await none.annotate({ time: 1, text: 'a' });
  await none.annotate({ time: 2, text: 'b' });
  assert.equal(requests.length, 1, 'no request without credentials');
  assert.equal(warnings.length, 1, 'one warning only');
  assert.equal(none.enabled, false);
});

test('postAnnotation never throws: a failure becomes a warning text', async () => {
  const warning = await postAnnotation({
    grafanaUrl: 'http://g',
    auth: { token: 't' },
    time: 1,
    tags: [],
    text: 'x',
    fetchFn: async () => {
      throw new Error('down');
    },
  });
  assert.match(warning, /not saved: down/);
});

test('kafka admin: lag per partition from end offsets and committed offsets (-1 = from the low watermark)', async () => {
  const admin = {
    connect: async () => {},
    disconnect: async () => {},
    fetchTopicOffsets: async () => [
      { partition: 0, high: '100', low: '0' },
      { partition: 1, high: '50', low: '10' },
    ],
    fetchOffsets: async () => [
      {
        topic: 'cce.events.inbound',
        partitions: [
          { partition: 0, offset: '90' },
          { partition: 1, offset: '-1' },
        ],
      },
    ],
    describeGroups: async () => ({ groups: [{ state: 'Stable', members: [] }] }),
    listTopics: async () => ['cce.events.inbound'],
  };
  class Kafka {
    admin() {
      return admin;
    }
  }
  const client = createKafkaAdmin(environment, { Kafka });
  const lag = await client.getGroupLag({
    groupId: 'cce-matcher-service',
    topic: 'cce.events.inbound',
  });
  assert.equal(lag.total, 50); // 10 + (50 − 10)
  assert.equal(await client.getTopicEndOffsetTotal('cce.events.inbound'), 150);
  assert.deepEqual(await client.describeGroup('cce-matcher-service'), {
    state: 'Stable',
    members: 0,
    assignedPartitions: 0,
  });
});
