/**
 * k6-runner.spec.mjs — unit tests of tools/core/k6-runner.mjs (plan §6.3, §9.3).
 *
 * What:    The exact docker arguments (container name k6-<runId>, uid:gid, run context, remote write + tags,
 *          --address on the host network vs published port elsewhere), test-file → container path, masking of
 *          secrets in the printed command, and stop/run with fake child processes (nothing is started).
 * How:     node --test tools/core/unit-tests/k6-runner.spec.mjs
 * Needs:   config/environments/local.json.
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  buildDockerArgs,
  findFreePort,
  formatDockerCommand,
  runK6,
  stopK6,
  toContainerPath,
} from '../k6-runner.mjs';
import { defaultValues, localEnvironment, tempDir } from './helpers.mjs';

const environment = localEnvironment();
const context = {
  runId: '20261105-142233',
  subject: 'collector',
  testType: 'load',
  k6: { apiPort: 40123 },
  resultsDirInContainer: '/tests/results/collector-load-20261105-142233',
  planDefinitionSet: { name: 'overlapping-4' },
  environment: { name: 'local' },
};
const base = {
  environment,
  context,
  settings: defaultValues(),
  scriptPath: '/tests/x/collector-load.test.js',
  repoRoot: '/repo',
  uid: 1001,
  gid: 1002,
};

/** Value after a flag, e.g. valueOf(args, '--name'). */
const valueOf = (args, flag) => args[args.indexOf(flag) + 1];
/** Every value of a repeated flag, e.g. all --tag values. */
const valuesOf = (args, flag) => args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));

test('host network: name, uid:gid, mount, run context, --address 127.0.0.1:<port>, no -p', () => {
  const args = buildDockerArgs(base);
  assert.deepEqual(args.slice(0, 2), ['run', '--rm']);
  assert.equal(valueOf(args, '--name'), 'k6-20261105-142233');
  assert.equal(valueOf(args, '--network'), 'host');
  assert.equal(valueOf(args, '-u'), '1001:1002');
  assert.equal(valueOf(args, '-v'), '/repo:/tests');
  assert.equal(valueOf(args, '-w'), '/tests');
  assert.ok(
    args.includes('RUN_CONTEXT=/tests/results/collector-load-20261105-142233/run-context.json'),
  );
  assert.equal(valueOf(args, '--address'), '127.0.0.1:40123');
  assert.ok(!args.includes('-p'));
  assert.equal(args.at(-1), '/tests/x/collector-load.test.js');
});

test('another docker network: --address 0.0.0.0:<port> and -p 127.0.0.1:<port>:<port>', () => {
  const args = buildDockerArgs({
    ...base,
    environment: { ...environment, k6: { ...environment.k6, dockerNetwork: 'cce-net' } },
  });
  assert.equal(valueOf(args, '--address'), '0.0.0.0:40123');
  assert.equal(valueOf(args, '-p'), '127.0.0.1:40123:40123');
});

test('monitoring on: Prometheus remote write env vars, -o experimental-prometheus-rw and the five tags', () => {
  const args = buildDockerArgs(base);
  assert.ok(args.includes('K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9095/api/v1/write'));
  assert.ok(args.includes('K6_PROMETHEUS_RW_TREND_STATS=p(95),p(99),avg,med,min,max'));
  assert.ok(args.includes('K6_PROMETHEUS_RW_STALE_MARKERS=true'));
  assert.ok(args.includes('K6_PROMETHEUS_RW_PUSH_INTERVAL=5s'));
  assert.equal(valueOf(args, '-o'), 'experimental-prometheus-rw');
  assert.deepEqual(valuesOf(args, '--tag'), [
    'testid=20261105-142233',
    'service=collector',
    'test_type=load',
    'plan_definition_set=overlapping-4',
    'environment=local',
  ]);
  // The image comes before "run" and the k6 flags after it.
  assert.equal(args[args.indexOf('run', 2) - 1], 'cce-load-tests/k6:2.3.0-kafka2.2.0');
});

test('monitoring off or PROMETHEUS_REMOTE_WRITE=false: no remote write at all, tags kept', () => {
  for (const variant of [
    {
      ...base,
      environment: { ...environment, monitoring: { ...environment.monitoring, enabled: false } },
    },
    { ...base, settings: defaultValues({ PROMETHEUS_REMOTE_WRITE: 'false' }) },
  ]) {
    const args = buildDockerArgs(variant);
    assert.ok(!args.includes('-o'));
    assert.ok(!args.some((a) => a.startsWith('K6_PROMETHEUS_RW')));
    assert.equal(valuesOf(args, '--tag').length, 5);
  }
});

test('toContainerPath maps a module-relative file URL to /tests/…; outside the repo is refused', () => {
  const repo = tempDir();
  const file = path.join(repo, 'cce-x', 'tests', 'x-load.test.js');
  assert.equal(toContainerPath(pathToFileURL(file), repo), '/tests/cce-x/tests/x-load.test.js');
  assert.equal(toContainerPath(file, repo), '/tests/cce-x/tests/x-load.test.js');
  assert.throws(() => toContainerPath('/elsewhere/a.test.js', repo), /outside the repository/);
});

test('formatDockerCommand masks secrets and quotes shell characters', () => {
  const line = formatDockerCommand([
    'run',
    '-e',
    'DB_PASSWORD=s3cret',
    '-e',
    'GRAFANA_API_TOKEN=abc',
    '-e',
    'A=p(95),x',
  ]);
  assert.ok(!line.includes('s3cret') && !line.includes('abc'));
  assert.match(line, /DB_PASSWORD=\*\*\*/);
  assert.match(line, /'A=p\(95\),x'/);
});

test('stopK6 sends SIGINT to the container k6-<runId> (k6 still writes its summary)', async () => {
  const calls = [];
  await stopK6('20261105-142233', {
    execFileFn: (cmd, args, cb) => (calls.push([cmd, ...args]), cb()),
  });
  assert.deepEqual(calls, [['docker', 'kill', '--signal', 'SIGINT', 'k6-20261105-142233']]);
});

test('runK6 streams output to k6.log and onLine, and returns exit code and exitedAt', async () => {
  const dir = tempDir();
  const logFile = path.join(dir, 'k6.log');
  const lines = [];
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit('data', 'running\r50 VUs\n');
      child.stderr.emit('data', 'warning line\n');
      child.emit('close', 99, null);
    });
    return child;
  };
  const outcome = await runK6(['run'], { logFile, onLine: (l) => lines.push(l), spawnFn });
  assert.equal(outcome.exitCode, 99);
  assert.match(outcome.exitedAt, /^\d{4}-\d{2}-\d{2}T.*[+-]\d{2}:\d{2}$/);
  assert.deepEqual(lines, ['running', '50 VUs', 'warning line']);
  await new Promise((r) => setTimeout(r, 20));
  assert.match(fs.readFileSync(logFile, 'utf8'), /warning line/);
});

test('findFreePort returns a usable local port number', async () => {
  const port = await findFreePort();
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
});
