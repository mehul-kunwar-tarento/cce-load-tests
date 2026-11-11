/**
 * dashboards.spec.mjs — static checks of the Grafana dashboards, provisioning and monitoring compose file
 *
 * What:    Proves, WITHOUT starting anything, that the five dashboards are valid JSON with the agreed
 *          uids, use the ${DS_PROMETHEUS} datasource variable everywhere, query only metric names on the
 *          allow-list of plan 000 §9.4, explain every panel, let a Step SLA run id be typed into
 *          "testid", and carry the run annotations; and that provisioning, Prometheus config and compose
 *          file follow the rules of spec 004 (remote-write receiver, exporters on by default, no secrets).
 * How:     node --test monitoring/unit-tests        (or: npm test, which includes monitoring/**)
 * Needs:   Node.js 22. No dependencies, no network: YAML files are checked as text.
 * Outputs: node:test results (exit code 0 = all rules hold). Exports METRIC_ALLOW_LIST,
 *          VERIFY_AT_FIRST_SCRAPE, DASHBOARD_UIDS and extractMetricNames() for reuse.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// monitoring/ folder, found relative to this file so the test works from any working directory.
const MONITORING_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD_DIR = join(MONITORING_DIR, 'grafana', 'dashboards');

/** The datasource reference every panel, target and Prometheus annotation must use (CCE's style). */
const DS_UID = '${DS_PROMETHEUS}';

/** Dashboard file → uid, exactly as plan 000 §9.4 lists them. */
export const DASHBOARD_UIDS = Object.freeze({
  'cce-performance-overview.json': 'cce-perf-overview',
  'cce-collector-service-performance.json': 'cce-perf-collector',
  'cce-matcher-service-performance.json': 'cce-perf-matcher',
  'cce-step-sla-service-performance.json': 'cce-perf-step-sla',
  'k6-load-test.json': 'cce-perf-k6',
});

/**
 * Every metric name a dashboard may query: the names of plan 000 §9.4 with its shorthand written out
 * (see specs/004-monitoring-and-grafana/plan.md § Interfaces). Why a list: a typo in a metric name
 * gives an empty panel and no error, so this catches it before anyone opens Grafana.
 */
export const METRIC_ALLOW_LIST = Object.freeze(
  new Set([
    // k6, pushed by remote write (trend values are seconds; panels in ms multiply by 1000)
    'k6_http_reqs_total',
    'k6_http_req_duration_p95',
    'k6_http_req_duration_p99',
    'k6_http_req_duration_avg',
    'k6_http_req_duration_max',
    'k6_http_req_failed_rate',
    'k6_dropped_iterations_total',
    'k6_vus',
    'k6_iterations_total',
    'k6_checks_rate',
    'k6_data_sent_total',
    'k6_data_received_total',
    'k6_kafka_writer_message_count_total',
    'k6_kafka_writer_error_count_total',
    // collector
    'cce_collector_events_received_total',
    'cce_collector_events_accepted_total',
    'cce_collector_events_duplicate_total',
    'cce_collector_events_rejected_total',
    'cce_collector_kafka_publish_success_total',
    'cce_collector_kafka_publish_failure_total',
    'cce_collector_ingestion_duration_seconds_sum',
    'cce_collector_ingestion_duration_seconds_count',
    'http_server_requests_seconds_sum',
    'http_server_requests_seconds_count',
    'http_server_requests_seconds_max',
    // matcher
    'cce_events_processed_total',
    'cce_events_matched_total',
    'cce_events_duplicate_total',
    'cce_consumer_inbound_errors_total',
    'cce_events_processing_duration_seconds_sum',
    'cce_events_processing_duration_seconds_count',
    'cce_events_processing_duration_seconds_max',
    'cce_step_matching_duration_seconds_sum',
    'cce_step_matching_duration_seconds_count',
    'cce_step_matching_duration_seconds_max',
    'cce_protocol_instances_active',
    'spring_kafka_listener_seconds_sum',
    'spring_kafka_listener_seconds_count',
    'spring_kafka_listener_seconds_max',
    // Step SLA
    'cce_sla_transitions_due',
    'cce_sla_transitions_applied_total',
    'cce_sla_transitions_skipped_total',
    'cce_sla_evaluator_cycles_total',
    'cce_sla_evaluator_batches_failed_total',
    // DB pool and JVM (all services)
    'hikaricp_connections_active',
    'hikaricp_connections_idle',
    'hikaricp_connections_pending',
    'hikaricp_connections_max',
    'hikaricp_connections_timeout_total',
    'jvm_memory_used_bytes',
    'jvm_gc_pause_seconds_max',
    'jvm_threads_live_threads',
    'tomcat_threads_busy_threads',
    // Kafka (kafka-exporter)
    'kafka_consumergroup_lag',
    'kafka_topic_partition_current_offset',
    // containers (cAdvisor) and host (node-exporter)
    'container_cpu_usage_seconds_total',
    'container_memory_working_set_bytes',
    'node_filesystem_avail_bytes',
    // Postgres (postgres-exporter)
    'pg_stat_activity_count',
    'pg_database_size_bytes',
    'pg_stat_database_tup_updated',
    'pg_replication_slot_slot_is_active',
    'pg_replication_slot_safe_wal_size_bytes',
    'pg_replication_slot_slot_current_wal_lsn',
    'pg_wal_size_bytes',
  ]),
);

/**
 * Names whose presence is not confirmed until the stack's first `up` (monitoring/README.md lists them).
 * Kept here so the README and the deferred task T040 have one list to work from.
 */
export const VERIFY_AT_FIRST_SCRAPE = Object.freeze(
  new Set([
    'k6_kafka_writer_message_count_total',
    'k6_kafka_writer_error_count_total',
    'tomcat_threads_busy_threads',
    'spring_kafka_listener_seconds_sum',
    'spring_kafka_listener_seconds_count',
    'spring_kafka_listener_seconds_max',
    'pg_replication_slot_slot_is_active',
    'pg_replication_slot_safe_wal_size_bytes',
    'pg_replication_slot_slot_current_wal_lsn',
    'pg_wal_size_bytes',
  ]),
);

/** PromQL words that look like identifiers but are not metric names. */
const PROMQL_KEYWORDS = new Set([
  'by',
  'without',
  'on',
  'ignoring',
  'group_left',
  'group_right',
  'bool',
  'and',
  'or',
  'unless',
  'offset',
  'inf',
  'nan',
]);

/**
 * Returns the metric names used in one PromQL expression. Why hand-written: no PromQL parser
 * dependency; our queries only use selectors, functions, aggregations and arithmetic.
 * @param {string} expr PromQL expression
 * @returns {string[]} metric names (may repeat)
 */
export function extractMetricNames(expr) {
  const stripped = expr
    .replace(/"(?:[^"\\]|\\.)*"/g, '""') // label values may contain anything (regexes, $vars)
    .replace(/\{[^}]*\}/g, ' ') // label matchers: label names are not metrics
    .replace(/\[[^\]]*\]/g, ' ') // range selectors such as [30s]
    .replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ' '); // grouping labels
  const names = [];
  for (const match of stripped.matchAll(/[A-Za-z_:][A-Za-z0-9_:]*/g)) {
    const before = stripped[match.index - 1] ?? '';
    const after = stripped.slice(match.index + match[0].length);
    if (/[0-9.]/.test(before)) continue; // part of a number such as 1e9
    if (/^\s*\(/.test(after)) continue; // a function or aggregation call: rate(, sum(, max(
    if (PROMQL_KEYWORDS.has(match[0].toLowerCase())) continue;
    names.push(match[0]);
  }
  return names;
}

/** Reads and parses every dashboard file once; the tests below share the result. */
function loadDashboards() {
  return readdirSync(DASHBOARD_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((file) => ({ file, json: JSON.parse(readFileSync(join(DASHBOARD_DIR, file), 'utf8')) }));
}

/** Panels including those nested in collapsed rows (Grafana keeps them in row.panels). */
function allPanels(dashboard) {
  return dashboard.panels.flatMap((panel) => [panel, ...(panel.panels ?? [])]);
}

/** Panels that query data (rows and text panels hold no queries). */
function queryPanels(dashboard) {
  return allPanels(dashboard).filter((panel) => panel.type !== 'row' && panel.type !== 'text');
}

/** Every PromQL expression of a dashboard with where it came from, for readable failure messages. */
function promqlExpressions(dashboard) {
  const found = [];
  for (const panel of queryPanels(dashboard)) {
    for (const target of panel.targets ?? [])
      found.push({ where: `panel "${panel.title}"`, expr: target.expr });
  }
  for (const annotation of dashboard.annotations.list) {
    if (annotation.expr)
      found.push({ where: `annotation "${annotation.name}"`, expr: annotation.expr });
  }
  return found;
}

/** Metric names used in the dashboard's query variables (label_values(<metric>{…}, <label>)). */
function variableMetricNames(dashboard) {
  return dashboard.templating.list
    .filter((variable) => variable.type === 'query')
    .map(
      (variable) => /label_values\(\s*([A-Za-z_:][A-Za-z0-9_:]*)/.exec(String(variable.query))?.[1],
    )
    .filter(Boolean);
}

/** Lists every file under a folder (recursive), for the header and secret scans. */
function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

/** Splits docker-compose.yml into its service blocks by indentation (no YAML parser needed). */
function composeServiceBlocks(text) {
  const services = text.split(/^services:\s*$/m)[1].split(/^\S/m)[0]; // up to the next top-level key
  const blocks = {};
  let current = null;
  for (const line of services.split('\n')) {
    const header = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
    if (header) {
      current = header[1];
      blocks[current] = '';
    } else if (current) {
      blocks[current] += `${line}\n`;
    }
  }
  return blocks;
}

/** Removes YAML comment lines so commented-out examples do not count as configuration. */
function withoutComments(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

const dashboards = loadDashboards();

test('exactly the five dashboards of plan 000 §9.4 exist, parse, and have their uids', () => {
  assert.deepEqual(dashboards.map((d) => d.file).sort(), Object.keys(DASHBOARD_UIDS).sort());
  for (const { file, json } of dashboards) assert.equal(json.uid, DASHBOARD_UIDS[file], file);
  const uids = dashboards.map((d) => d.json.uid);
  assert.equal(new Set(uids).size, uids.length, 'uids must be unique');
});

test('every dashboard has schemaVersion 39, a title and a What/How/Needs/Outputs description', () => {
  for (const { file, json } of dashboards) {
    assert.equal(json.schemaVersion, 39, file);
    assert.ok(json.title, `${file}: title`);
    for (const label of ['What:', 'How:', 'Needs:', 'Outputs:']) {
      assert.ok(json.description?.includes(label), `${file}: description lacks "${label}"`);
    }
  }
});

test('every panel and every target uses the ${DS_PROMETHEUS} datasource variable', () => {
  for (const { file, json } of dashboards) {
    for (const panel of queryPanels(json)) {
      assert.equal(panel.datasource?.uid, DS_UID, `${file}: panel "${panel.title}"`);
      assert.ok(panel.targets?.length > 0, `${file}: panel "${panel.title}" has no query`);
      for (const target of panel.targets) {
        assert.equal(
          target.datasource?.uid,
          DS_UID,
          `${file}: panel "${panel.title}" ${target.refId}`,
        );
        assert.ok(
          target.expr?.trim(),
          `${file}: panel "${panel.title}" ${target.refId} has an empty expr`,
        );
      }
    }
    for (const annotation of json.annotations.list.filter(
      (a) => a.datasource?.type === 'prometheus',
    )) {
      assert.equal(annotation.datasource.uid, DS_UID, `${file}: annotation "${annotation.name}"`);
    }
  }
});

test('every panel (including text panels) has a description for newcomers', () => {
  for (const { file, json } of dashboards) {
    for (const panel of allPanels(json).filter((p) => p.type !== 'row')) {
      assert.ok(
        panel.description?.trim().length > 20,
        `${file}: panel "${panel.title}" lacks a description`,
      );
    }
  }
});

test('panel ids are unique per dashboard and every panel fits the 24-column grid', () => {
  for (const { file, json } of dashboards) {
    const ids = allPanels(json).map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, `${file}: duplicate panel id`);
    for (const panel of allPanels(json)) {
      assert.ok(
        panel.gridPos.x + panel.gridPos.w <= 24,
        `${file}: panel "${panel.title}" overflows`,
      );
    }
  }
});

test('every metric name queried is on the allow-list, and every allow-list name is used', () => {
  const used = new Set();
  for (const { file, json } of dashboards) {
    for (const { where, expr } of promqlExpressions(json)) {
      for (const name of extractMetricNames(expr)) {
        assert.ok(
          METRIC_ALLOW_LIST.has(name),
          `${file}: ${where} uses "${name}", not on the allow-list`,
        );
        used.add(name);
      }
    }
    for (const name of variableMetricNames(json)) {
      assert.ok(METRIC_ALLOW_LIST.has(name), `${file}: variable query uses "${name}"`);
      used.add(name);
    }
  }
  const unused = [...METRIC_ALLOW_LIST].filter((name) => !used.has(name));
  assert.deepEqual(unused, [], 'allow-list names no panel uses (remove them or add the panel)');
  for (const name of VERIFY_AT_FIRST_SCRAPE) assert.ok(METRIC_ALLOW_LIST.has(name), name);
});

test('extractMetricNames ignores functions, labels, ranges, grouping and numbers', () => {
  assert.deepEqual(
    extractMetricNames(
      'sum by (job) (rate(foo_total{job=~"a|b",x="rate(y)"}[30s])) / bar_count * 1000',
    ),
    ['foo_total', 'bar_count'],
  );
  assert.deepEqual(
    extractMetricNames('max by (testid, service, test_type) (k6_vus{testid=~"$testid"})'),
    ['k6_vus'],
  );
  assert.deepEqual(extractMetricNames('min(node_filesystem_avail_bytes{mountpoint="/"}) > 2e9'), [
    'node_filesystem_avail_bytes',
  ]);
});

test('k6 trend values (seconds) are multiplied by 1000 on millisecond panels', () => {
  for (const { file, json } of dashboards) {
    for (const panel of queryPanels(json)) {
      for (const target of panel.targets) {
        if (/k6_http_req_duration_/.test(target.expr)) {
          assert.equal(
            panel.fieldConfig.defaults.unit,
            'ms',
            `${file}: panel "${panel.title}" unit`,
          );
          assert.match(
            target.expr,
            /\*\s*1000/,
            `${file}: panel "${panel.title}" must convert s → ms`,
          );
        }
      }
    }
  }
});

test('variables DS_PROMETHEUS, service, test_type and testid exist; testid accepts typed run ids', () => {
  for (const { file, json } of dashboards) {
    const byName = Object.fromEntries(json.templating.list.map((v) => [v.name, v]));
    assert.equal(byName.DS_PROMETHEUS?.type, 'datasource', `${file}: DS_PROMETHEUS`);
    assert.equal(byName.DS_PROMETHEUS.query, 'prometheus', `${file}: DS_PROMETHEUS query`);
    assert.ok(['query', 'constant'].includes(byName.service?.type), `${file}: service`);
    assert.equal(byName.test_type?.type, 'query', `${file}: test_type`);
    const testid = byName.testid;
    assert.equal(testid?.type, 'query', `${file}: testid`);
    assert.match(
      String(testid.query),
      /^label_values\(k6_vus(\{[^}]*\})?\s*,\s*testid\)$/,
      `${file}: testid query`,
    );
    assert.equal(testid.multi, true, `${file}: testid multi`);
    assert.equal(testid.includeAll, true, `${file}: testid include All`);
    assert.equal(testid.allowCustomValue, true, `${file}: testid custom values`);
  }
});

test('every dashboard has the k6 region annotation and the runner annotations on tag cce-performance', () => {
  for (const { file, json } of dashboards) {
    const list = json.annotations.list;
    const k6Region = list.find((a) => a.datasource?.type === 'prometheus' && a.enable);
    assert.equal(
      k6Region?.expr,
      'max by (testid, service, test_type) (k6_vus{testid=~"$testid"})',
      `${file}: k6 region annotation`,
    );
    const selected = list.find(
      (a) =>
        a.datasource?.type === 'grafana' &&
        a.enable &&
        a.target?.type === 'tags' &&
        a.target.tags.includes('cce-performance') &&
        a.target.tags.includes('$testid'),
    );
    assert.ok(selected, `${file}: annotation on tags cce-performance + $testid`);
    assert.equal(selected.target.matchAny, false, `${file}: both tags must match`);
  }
});

test('provisioning: default datasource "Prometheus" uid prometheus; file provider into "CCE Performance"', () => {
  const ds = readFileSync(
    join(MONITORING_DIR, 'grafana/provisioning/datasources/datasources.yml'),
    'utf8',
  );
  for (const line of [
    'name: Prometheus',
    'uid: prometheus',
    'type: prometheus',
    'url: http://prometheus:9090',
    'isDefault: true',
  ]) {
    assert.ok(withoutComments(ds).includes(line), `datasources.yml lacks "${line}"`);
  }
  const db = withoutComments(
    readFileSync(join(MONITORING_DIR, 'grafana/provisioning/dashboards/dashboards.yml'), 'utf8'),
  );
  assert.match(db, /type: file/);
  assert.match(db, /folder: 'CCE Performance'/);
  assert.match(db, /path: \/var\/lib\/grafana\/dashboards/);
});

test('prometheus.yml scrapes every 5 s with the job names of CCE', () => {
  const text = withoutComments(
    readFileSync(join(MONITORING_DIR, 'prometheus/prometheus.yml'), 'utf8'),
  );
  assert.match(text, /^\s+scrape_interval: 5s$/m);
  const jobs = [...text.matchAll(/job_name: '([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(jobs, [
    'cadvisor',
    'cce-collector-service',
    'cce-matcher-service',
    'cce-protocol-service',
    'cce-step-sla-service',
    'kafka',
    'node-exporter',
    'postgres',
    'prometheus',
  ]);
});

test('compose: images, ports, remote-write receiver, exporters on by default, external network, no secrets', () => {
  const raw = readFileSync(join(MONITORING_DIR, 'docker-compose.yml'), 'utf8');
  const text = withoutComments(raw);
  const blocks = composeServiceBlocks(text);
  assert.deepEqual(Object.keys(blocks).sort(), [
    'cadvisor',
    'grafana',
    'kafka-exporter',
    'node-exporter',
    'postgres-exporter',
    'prometheus',
  ]);
  const images = {
    prometheus: 'prom/prometheus:v2.51.2',
    grafana: 'grafana/grafana:10.4.2',
    'kafka-exporter': 'danielqsj/kafka-exporter:v1.7.0',
    'postgres-exporter': 'prometheuscommunity/postgres-exporter:v0.15.0',
    cadvisor: 'gcr.io/cadvisor/cadvisor:v0.49.1',
    'node-exporter': 'prom/node-exporter:v1.8.1',
  };
  for (const [service, image] of Object.entries(images)) {
    assert.match(
      blocks[service],
      new RegExp(`image: ${image.replace(/[./]/g, '\\$&')}\\n`),
      service,
    );
  }
  assert.match(blocks.prometheus, /--web\.enable-remote-write-receiver/);
  assert.match(blocks.prometheus, /'\$\{PROMETHEUS_PORT:-9095\}:9090'/);
  assert.match(blocks.grafana, /'\$\{GRAFANA_PORT:-3030\}:3000'/);
  assert.match(blocks.grafana, /GF_SECURITY_ADMIN_PASSWORD: \$\{GRAFANA_ADMIN_PASSWORD:\?/);
  assert.match(blocks.grafana, /GF_AUTH_ANONYMOUS_ORG_ROLE: Viewer/);
  assert.match(blocks.grafana, /provisioning:\/etc\/grafana\/provisioning:ro/);
  assert.match(blocks.grafana, /dashboards:\/var\/lib\/grafana\/dashboards:ro/);
  assert.match(blocks['kafka-exporter'], /--kafka\.server=kafka:9092/);
  assert.match(
    blocks['postgres-exporter'],
    /DATA_SOURCE_URI: 'postgres:5432\/ccedb\?sslmode=disable'/,
  );
  assert.match(blocks['postgres-exporter'], /DATA_SOURCE_USER: cce_user/);
  assert.match(blocks['postgres-exporter'], /DATA_SOURCE_PASS: \$\{DB_PASSWORD:\?/);
  for (const service of ['cadvisor', 'node-exporter']) {
    assert.doesNotMatch(blocks[service], /profiles:/, `${service} must start by default`);
  }
  assert.match(
    blocks['node-exporter'],
    /- \/:\/host:ro,rslave/,
    'node-exporter must see the host root',
  );
  assert.match(text, /external: true\n\s+name: \$\{CCE_NETWORK:-cce-net\}/);
  // Every password-like key takes its value from a required variable, never a literal ([ \t] not \s:
  // \s would run on into the next line).
  for (const m of text.matchAll(/^[ \t]*\w*(?:PASSWORD|PASS|TOKEN|SECRET)\w*:[ \t]*(.*)$/gim)) {
    assert.match(m[1], /^\$\{[A-Z_]+:\?/, `literal secret in compose: ${m[0].trim()}`);
  }
});

test('no password or token value in any monitoring file', () => {
  const self = fileURLToPath(import.meta.url);
  for (const file of listFiles(MONITORING_DIR).filter((f) => f !== self)) {
    const text = readFileSync(file, 'utf8');
    for (const known of ['cce_pass', 'cceadmin', 'admin@123']) {
      assert.ok(!text.includes(known), `${relative(MONITORING_DIR, file)} contains "${known}"`);
    }
    if (['.yml', '.yaml', '.json'].includes(extname(file)) || basename(file) === '.env.example') {
      for (const m of withoutComments(text).matchAll(
        /^[ \t]*"?\w*(?:PASSWORD|PASS|TOKEN|SECRET)\w*"?[ \t]*[:=][ \t]*(.*)$/gim,
      )) {
        assert.match(m[1], /^$|^\$\{/, `${relative(MONITORING_DIR, file)}: ${m[0].trim()}`);
      }
    }
  }
});

test('every monitoring file carries a What/How/Needs/Outputs header (plan 000 §2.4)', () => {
  for (const file of listFiles(MONITORING_DIR)) {
    const name = relative(MONITORING_DIR, file);
    if (name.startsWith(`grafana${'/'}dashboards${'/'}`) && name.endsWith('.json')) continue; // description, tested above
    const head = readFileSync(file, 'utf8').split('\n').slice(0, 30).join('\n');
    for (const label of ['What:', 'How:', 'Needs:', 'Outputs:']) {
      assert.ok(head.includes(label), `${name}: header lacks "${label}"`);
    }
  }
});
