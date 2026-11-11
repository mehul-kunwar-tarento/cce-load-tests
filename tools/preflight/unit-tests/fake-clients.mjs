/**
 * fake-clients.mjs — a fake CCE stack for preflight unit tests (no network, no database, no Docker)
 *
 * What:    Builds every client preflight uses (HTTP, Prometheus scrape, Postgres, Kafka admin, protocol API,
 *          docker exec, statfs, sleep) answering like a HEALTHY laptop stack. Each test overrides only the part
 *          it breaks (e.g. the matcher health is DOWN, a replication slot is lost). Every call is recorded so
 *          tests can assert e.g. that /actuator/health was called once per service.
 * How:     import { fakeStack, localEnvironment, MODULES } from './fake-clients.mjs';
 *          const stack = fakeStack({ health: { matcher: { status: 'DOWN' } } });
 *          await runPreflight({ environment: localEnvironment(), subjects: ['matcher'], settings, clients: stack.clients, modules: MODULES, … });
 * Needs:   Nothing external (imported by *.spec.mjs files in tools/preflight/ and tools/commands/).
 * Outputs: { clients, calls, environment helpers } — fakes only.
 */
import { LOADTEST_MARKER } from '../../plan-definitions/sets.mjs';

/** The service modules' `requires` (plan §6.4), as B1–B3 declare them. */
export const MODULES = [
  {
    subject: 'collector',
    service: 'cce-collector-service',
    kind: 'k6',
    requires: { services: ['collector'], postgres: true, kafka: true, protocol: true },
  },
  {
    subject: 'matcher',
    service: 'cce-matcher-service',
    kind: 'k6',
    requires: { services: ['matcher'], postgres: true, kafka: true, protocol: true },
  },
  {
    subject: 'step-sla',
    service: 'cce-step-sla-service',
    kind: 'seeded',
    requires: { services: ['step-sla'], postgres: true, kafka: false, protocol: true },
  },
];

/** A laptop environment shaped like config/environments/local.json (plan §3.1). */
export function localEnvironment(changes = {}) {
  const service = (port, extra = {}) => ({
    baseUrl: `http://localhost:${port}`,
    healthPath: '/actuator/health',
    metricsPath: '/actuator/prometheus',
    ...extra,
  });
  return {
    name: 'local',
    kind: 'local',
    configFile: 'config/environments/local.json',
    services: {
      collector: service(8093),
      matcher: service(8097),
      stepSla: service(8099, { pollIntervalSeconds: 5 }),
      protocol: {
        baseUrl: 'http://localhost:8096',
        healthPath: '/actuator/health',
        apiPath: '/v1/protocol/protocol-definitions',
      },
    },
    kafka: {
      brokers: ['localhost:29092'],
      inboundTopic: 'cce.events.inbound',
      matcherConsumerGroup: 'cce-matcher-service',
      expectedPartitions: 25,
    },
    database: {
      host: 'localhost',
      port: 15433,
      name: 'ccedb',
      user: 'cce_user',
      passwordEnvVar: 'DB_PASSWORD',
      expectedTables: [
        'inbound_event_log',
        'matcher_event_log',
        'protocol_instance',
        'step_instance',
        'step_sla_state_transition',
      ],
      replicationSlots: ['cce_analytics_slot'],
    },
    k6: { image: 'cce-load-tests/k6:2.3.0-kafka2.2.0', dockerNetwork: 'host' },
    monitoring: {
      enabled: true,
      prometheusUrl: 'http://localhost:9095',
      remoteWriteUrl: 'http://localhost:9095/api/v1/write',
      grafanaUrl: 'http://localhost:3030',
      grafanaUser: 'admin',
    },
    safety: {
      allowCleanup: true,
      allowTempIndex: true,
      allowPlanDefinitionChanges: true,
      minFreeDiskGb: 20,
    },
    settings: {},
    ...changes,
  };
}

/** The same stack seen as a shared Dev environment (remote data stores). */
export function devEnvironment(changes = {}) {
  return localEnvironment({
    name: 'dev',
    kind: 'dev',
    configFile: 'config/environments/dev.json',
    ...changes,
  });
}

const GB = 1024 ** 3;

/** Default answers of the fake database, by query name (regex on the SQL → rows). */
function defaultDbHandlers() {
  return [
    ['select1', /SELECT 1 AS ok/, () => [{ ok: 1 }]],
    [
      'target',
      /inet_server_port/,
      () => [{ database: 'ccedb', server_port: 5432, version: 'PostgreSQL 16.4' }],
    ],
    [
      'tables',
      /information_schema\.tables/,
      (params) => params[0].map((table_name) => ({ table_name })),
    ],
    [
      'stepGroups',
      /to_regclass\('step_group_instance'\)/,
      () => [{ has_table: true, has_column: true }],
    ],
    ['overlap', /FROM trigger_index/, () => []],
    ['conditionOnly', /jsonb_path_exists/, () => []],
    [
      'slots',
      /FROM pg_replication_slots/,
      () => [
        {
          slot_name: 'cce_analytics_slot',
          active: true,
          wal_status: 'reserved',
          safe_wal_size: 8 * GB,
          lag_bytes: 1024,
        },
      ],
    ],
    ['maxSlotWalKeep', /max_slot_wal_keep_size/, () => [{ max_slot_wal_keep_size: '10GB' }]],
    ['dbSize', /pg_database_size/, () => [{ db_size_bytes: 2 * GB }]],
    ['walSize', /pg_ls_waldir/, () => [{ wal_bytes: 0.5 * GB }]],
    ['vacuumRunning', /pg_stat_progress_vacuum/, () => [{ running: 0 }]],
    [
      'deadRows',
      /n_dead_tup/,
      (params) => params[0].map((relname) => ({ relname, n_live_tup: 1000, n_dead_tup: 10 })),
    ],
    ['recentTestData', /patient_id LIKE 'LOADTEST-%'\) AS found/, () => [{ found: false }]],
    ['dueAlarms', /AS first_ring/, () => [{ due: 0, first_ring: null }]],
  ];
}

/** A Map in the shape of A2's parsePrometheusText: name → [{labels, value}]. */
export function metrics(values) {
  return new Map(Object.entries(values).map(([name, value]) => [name, [{ labels: {}, value }]]));
}

/**
 * Build a fake stack.
 * @param {object} [o]
 * @param {Record<string, object|Error>} [o.health] subject → actuator health body (or an Error = not answering)
 * @param {Record<string, Record<string, number>|Error>} [o.metrics] subject → metrics
 * @param {Record<string, Function|Error>} [o.db] query name (see defaultDbHandlers) → (params) => rows, or an Error
 * @param {object} [o.kafka] { topics, partitions, group } overrides
 * @param {Record<string, object|null>} [o.protocol] canonical → stored DTO (null = missing)
 * @param {{results?: number, docker?: number}} [o.freeGb]
 * @param {Record<string, number|null>} [o.http] url suffix → status (null = no answer)
 * @param {{dockerVersion?: number, imageInspect?: number}} [o.exec] exit codes
 * @param {number[]} [o.cycles] successive values of cce_sla_evaluator_cycles_total
 * @param {Record<string,string>} [o.env]
 */
export function fakeStack(o = {}) {
  const calls = { http: [], scrape: [], db: [], kafka: [], exec: [], sleep: [], statfs: [] };
  const environment = o.environment ?? localEnvironment();
  const ports = { 8093: 'collector', 8097: 'matcher', 8099: 'step-sla', 8096: 'protocol' };
  const subjectOf = (url) => ports[new URL(url).port] ?? null;

  const http = {
    async request({ method, url, body }) {
      calls.http.push({ method, url, body });
      const override = Object.entries(o.http ?? {}).find(([suffix]) => url.endsWith(suffix));
      if (override) {
        if (override[1] === null) throw new Error('ECONNREFUSED');
        return { status: override[1], body: null };
      }
      if (url.endsWith('/actuator/health')) {
        const health = o.health?.[subjectOf(url)] ?? { status: 'UP' };
        if (health instanceof Error) throw health;
        return { status: health.status === 'UP' ? 200 : 503, body: health };
      }
      if (url.endsWith('/-/ready')) return { status: 200, body: 'Prometheus Server is Ready.' };
      if (url.endsWith('/api/v1/write')) return { status: 400, body: 'empty write request' };
      if (url.endsWith('/api/health')) return { status: 200, body: { database: 'ok' } };
      return { status: 404, body: null };
    },
  };

  let cycleCall = 0;
  const defaultMetrics = {
    collector: { cce_collector_events_received_total: 0 },
    matcher: { cce_events_processed_total: 0 },
    'step-sla': { cce_sla_transitions_due: 0 },
  };
  const scrapeUrl = async (url) => {
    calls.scrape.push(url);
    const subject = subjectOf(url);
    const values = o.metrics?.[subject] ?? defaultMetrics[subject] ?? {};
    if (values instanceof Error) throw values;
    if (subject === 'step-sla') {
      // The scheduler check scrapes twice; by default the counter grows by one cycle each time.
      const cycles = o.cycles ?? [10, 11, 12, 13];
      return metrics({
        ...values,
        cce_sla_evaluator_cycles_total: cycles[Math.min(cycleCall++, cycles.length - 1)],
      });
    }
    return metrics(values);
  };

  const handlers = defaultDbHandlers();
  const db = {
    async query(sql, params = [], options = {}) {
      calls.db.push({ sql, params, options });
      for (const [name, test, answer] of handlers) {
        if (!test.test(sql)) continue;
        const custom = o.db?.[name];
        if (custom instanceof Error) throw custom;
        return (custom ?? answer)(params);
      }
      return [];
    },
  };

  const kafka = {
    topics: ['cce.events.inbound', 'cce.events.inbound.dlq'],
    partitions: 25,
    lag: 0,
    group: { state: 'Stable', members: 2, assignedPartitions: 25 },
    ...(o.kafka ?? {}),
  };
  const kafkaAdmin = {
    connect: async () => calls.kafka.push('connect'),
    disconnect: async () => calls.kafka.push('disconnect'),
    listTopics: async () => kafka.topics,
    getGroupLag: async () => ({
      total: kafka.lag,
      partitions: Array.from({ length: kafka.partitions }, (_, partition) => ({
        partition,
        high: 0,
        committed: 0,
        lag: partition === 0 ? kafka.lag : 0,
      })),
    }),
    describeGroup: async () => kafka.group,
  };
  if (o.kafka?.describeLogDirs) kafkaAdmin.describeLogDirs = o.kafka.describeLogDirs;

  const protocolApi = {
    async getByUrlVersion(url, version) {
      const canonical = `${url}|${version}`;
      if (o.protocol && Object.hasOwn(o.protocol, canonical)) return o.protocol[canonical];
      return {
        id: `id-${canonical}`,
        url,
        version,
        status: 'ACTIVE',
        loadedAt: '2026-11-05T10:00:00Z',
        definition: { meta: { tag: [{ ...LOADTEST_MARKER }] } },
      };
    },
  };

  const exec = async (cmd, args) => {
    calls.exec.push([cmd, ...args].join(' '));
    if (args[0] === 'version')
      return {
        code: o.exec?.dockerVersion ?? 0,
        stdout: '27.3.1\n',
        stderr: o.exec?.dockerVersion ? 'Cannot connect to the Docker daemon' : '',
      };
    if (args[0] === 'image')
      return { code: o.exec?.imageInspect ?? 0, stdout: 'sha256:abc\n', stderr: '' };
    if (args[0] === 'info') return { code: 0, stdout: '/var/lib/docker\n', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unknown' };
  };

  const resultsRoot = o.resultsRoot ?? null;
  const statfs = async (target) => {
    calls.statfs.push(target);
    const isResults = resultsRoot && target.startsWith(resultsRoot);
    const freeGb = isResults ? (o.freeGb?.results ?? 100) : (o.freeGb?.docker ?? 100);
    return { bavail: (freeGb * GB) / 4096, bsize: 4096 };
  };

  const clients = {
    http,
    scrapeUrl,
    db: o.noDb ? null : db,
    kafkaAdmin,
    protocolApi,
    exec,
    statfs,
    sleep: async (ms) => calls.sleep.push(ms),
    env: o.env ?? { DB_PASSWORD: 'secret-for-tests', GRAFANA_API_TOKEN: 'token-for-tests' },
  };
  return { clients, calls, environment };
}
