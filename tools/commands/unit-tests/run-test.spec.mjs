/**
 * run-test.spec.mjs — unit tests of tools/commands/run-test.mjs (the `run` lifecycle, plan §6.2).
 *
 * What:    With the stub service module and fakes for every outside effect (no Docker, no connections):
 *          --dry-run prints settings, phase plan and the masked docker command and writes nothing; a full run
 *          writes run-context.json, preflight.json, data-checks.json, a valid result.json and report.md and
 *          exits 0; Ctrl-C stops k6 with SIGINT and ends "aborted" (exit 1); a failed preflight refuses the
 *          run (exit 2); --refine-from sets LEVELS and WARM_UP_RATE from a previous breakpoint result
 *          (source "refine-from"; the tester's --set still wins).
 * How:     node --test tools/commands/unit-tests/run-test.spec.mjs
 * Needs:   tools/core/unit-tests/fixtures/stub-service/, fixtures/run-test/.
 * Outputs: Test results only (temporary results folders).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setTimesFromStart } from '../../core/k6-clock.mjs';
import { validateResult } from '../../core/result-schema.mjs';
import { sink, tempDir } from '../../core/unit-tests/helpers.mjs';
import { main } from '../run-test.mjs';

const MODULES_ROOT = new URL('../../core/unit-tests/fixtures', import.meta.url).pathname;
const FIXTURES = new URL('./fixtures/run-test/', import.meta.url).pathname;
const SMALL = ['--set', 'WARM_UP_DURATION=0s', '--set', 'LOAD_EVENTS=100'];

/** Fakes for a whole run; `onK6` runs while the fake k6 "runs". */
function fakeDeps({ resultsRoot, preflightStatus = 'passed', onK6 = async () => {} } = {}) {
  const calls = { stopK6: [], annotations: [], dockerArgs: null };
  let signalHandler = null;
  const deps = {
    env: { GRAFANA_ADMIN_PASSWORD: 'secret-pw' },
    now: () => new Date(),
    resultsRoot,
    findFreePort: async () => 45678,
    createRunClients: async () => ({
      pgPool: null,
      kafkaAdmin: null,
      protocolApi: null,
      scrape: async () => new Map(),
      scrapeUrl: async () => new Map(),
      preflightClients: () => ({}),
      close: async () => {},
    }),
    runPreflight: async ({ subjects }) => ({
      schemaVersion: '1.0.0',
      kind: 'cce-preflight',
      environment: 'local',
      subject: subjects[0],
      startedAt: new Date().toISOString(),
      status: preflightStatus,
      checks: [
        {
          id: 'environment',
          title: 'Environment',
          severity: 'required',
          status: preflightStatus === 'failed' ? 'fail' : 'pass',
          detail: '',
        },
      ],
    }),
    captureConditions: async ({ environment }) => ({
      environment: {
        name: environment.name,
        kind: environment.kind,
        configFile: environment.configFile,
        serviceUrls: {},
      },
      host: { hostname: 'test-host', cpus: 4, k6Image: environment.k6.image },
      suite: { gitCommit: 'abc1234', gitDirty: false },
      planDefinitionSet: null,
      dataVolume: null,
    }),
    startK6Clock: ({ phasePlan, times }) => {
      setTimesFromStart(times, phasePlan, Date.now(), 'k6-rest-api');
      times.markReady();
      return { stop() {} };
    },
    runK6: async (args, { logFile }) => {
      calls.dockerArgs = args;
      await onK6({ signal: () => signalHandler?.() });
      // k6's handleSummary: the fixture with the real phase plan and start time filled in.
      const dir = path.dirname(logFile);
      const context = JSON.parse(fs.readFileSync(path.join(dir, 'run-context.json'), 'utf8'));
      const summary = JSON.parse(
        fs.readFileSync(path.join(FIXTURES, 'k6-summary-stub-load.json'), 'utf8'),
      );
      summary.context = {
        ...summary.context,
        runId: context.runId,
        phasePlan: context.phasePlan,
        k6StartedAt: new Date(Date.now() - 2100).toISOString(),
      };
      fs.writeFileSync(path.join(dir, 'k6-summary.json'), JSON.stringify(summary));
      fs.writeFileSync(logFile, 'k6 output\n');
      return { exitCode: 0, exitedAt: new Date().toISOString() };
    },
    stopK6: async (runId) => calls.stopK6.push(runId),
    createAnnotator: () => ({
      enabled: true,
      authKind: 'basic',
      annotate: async (a) => calls.annotations.push(a.text),
    }),
    onSignal: (signal, handler) => {
      assert.equal(signal, 'SIGINT');
      signalHandler = handler;
      return () => (signalHandler = null);
    },
  };
  return { deps, calls };
}

test('--dry-run: settings, phase plan, masked docker command; nothing written or connected', async () => {
  const resultsRoot = tempDir();
  const out = sink();
  let connected = false;
  const code = await main(
    [
      'local',
      'stub',
      'load',
      '--dry-run',
      '--modules-root',
      MODULES_ROOT,
      '--set',
      'LOAD_EVENTS=1000',
    ],
    { stdout: out },
    {
      resultsRoot,
      findFreePort: async () => {
        connected = true;
        return 1;
      },
      createRunClients: async () => {
        connected = true;
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(connected, false, 'a dry run opens no socket and builds no client');
  assert.deepEqual(fs.readdirSync(resultsRoot), [], 'nothing written');
  assert.match(out.text, /DRY RUN — Stub load/);
  assert.match(out.text, /\| LOAD_DURATION \| 20s \| derived \|/);
  assert.match(out.text, /\| measure \| constant \| 50\/s \| 1m 0s \| 20s \| 1,000 \|/);
  assert.match(out.text, /docker run --rm --name k6-\d{8}-\d{6} --network host/);
  assert.match(
    out.text,
    /--address 127\.0\.0\.1:6565 \/tests\/tools\/core\/unit-tests\/fixtures\/stub-service\/tests\/stub-load\.test\.js/,
  );
  assert.match(
    out.text,
    /--tag service=stub --tag test_type=load --tag plan_definition_set=emr-service --tag environment=local/,
  );
  assert.match(out.text, /Dry run: nothing was written, started or connected/);
});

test('full run with fakes: every result file, a valid passed result.json, report.md, exit 0', async () => {
  const resultsRoot = tempDir();
  const { deps, calls } = fakeDeps({ resultsRoot });
  const out = sink();
  const code = await main(
    ['local', 'stub', 'load', '--modules-root', MODULES_ROOT, ...SMALL],
    { stdout: out, stderr: sink() },
    deps,
  );
  assert.equal(code, 0, out.text.slice(-2000));
  const [folder] = fs.readdirSync(resultsRoot);
  assert.match(folder, /^stub-load-\d{8}-\d{6}$/);
  const dir = path.join(resultsRoot, folder);
  for (const file of [
    'run-context.json',
    'preflight.json',
    'k6-summary.json',
    'k6.log',
    'data-checks.json',
    'result.json',
    'report.md',
  ]) {
    assert.ok(fs.existsSync(path.join(dir, file)), file);
  }
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  assert.deepEqual(validateResult(result), []);
  assert.equal(result.status, 'passed');
  assert.equal(result.timing.source, 'k6-setup');
  assert.equal(result.load.eventsSent, 100);
  assert.equal(result.load.plannedEvents, 100);
  assert.equal(result.latency.p95, 12.5);
  assert.equal(result.conditions.settings.LOAD_DURATION.value, 2);
  assert.equal(result.conditions.settings.LOAD_DURATION.source, 'derived');
  assert.equal(result.conditions.preflight.status, 'passed');
  assert.equal(result.artifacts.k6ExitCode, 0);
  // The docker command had the real free port and the run's own name.
  assert.ok(calls.dockerArgs.includes('127.0.0.1:45678'));
  assert.ok(calls.dockerArgs.includes(`k6-${result.runId}`));
  // Grafana annotations for the run (start, region, phase marks).
  assert.match(calls.annotations.join('|'), /run started/);
  assert.match(calls.annotations.join('|'), /measured phase started/);
  assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /^# Stub load — PASSED/);
  assert.match(out.text, /# Stub load — PASSED/);
  const context = JSON.parse(fs.readFileSync(path.join(dir, 'run-context.json'), 'utf8'));
  assert.equal(context.k6.apiPort, 45678);
  assert.ok(!JSON.stringify(context).includes('secret-pw'), 'no secret in the run context');
});

test('Ctrl-C: k6 gets SIGINT (docker kill k6-<runId>), the run ends aborted with partial data, exit 1', async () => {
  const resultsRoot = tempDir();
  const { deps, calls } = fakeDeps({ resultsRoot, onK6: async ({ signal }) => signal() });
  const code = await main(
    ['local', 'stub', 'load', '--modules-root', MODULES_ROOT, ...SMALL],
    { stdout: sink(), stderr: sink() },
    deps,
  );
  assert.equal(code, 1);
  const [folder] = fs.readdirSync(resultsRoot);
  const result = JSON.parse(fs.readFileSync(path.join(resultsRoot, folder, 'result.json'), 'utf8'));
  assert.equal(result.status, 'aborted');
  assert.match(result.statusReason, /Ctrl-C/);
  assert.deepEqual(calls.stopK6, [result.runId]);
  assert.equal(result.load.eventsSent, 100, 'partial data kept');
});

test('a failed required preflight check refuses the run (exit 2): preflight.json kept, no result.json', async () => {
  const resultsRoot = tempDir();
  const { deps, calls } = fakeDeps({ resultsRoot, preflightStatus: 'failed' });
  const code = await main(
    ['local', 'stub', 'load', '--modules-root', MODULES_ROOT, ...SMALL],
    { stdout: sink(), stderr: sink() },
    deps,
  );
  assert.equal(code, 2);
  const [folder] = fs.readdirSync(resultsRoot);
  assert.ok(fs.existsSync(path.join(resultsRoot, folder, 'preflight.json')));
  assert.ok(!fs.existsSync(path.join(resultsRoot, folder, 'result.json')));
  assert.equal(calls.dockerArgs, null, 'k6 never started');
});

test('--refine-from: LEVELS between held and broke, warm-up at the held rate (unless the tester set them)', async () => {
  const out = sink();
  const refine = path.join(FIXTURES, 'refine-from');
  await main(
    [
      'local',
      'stub',
      'breakpoint',
      '--dry-run',
      '--modules-root',
      MODULES_ROOT,
      '--refine-from',
      refine,
    ],
    { stdout: out },
    { resultsRoot: tempDir() },
  );
  // Their own source: the tester did not type them (finding: they used to show as "cli").
  assert.match(out.text, /\| LEVELS \| 500,600,700 \| refine-from \|/);
  assert.match(out.text, /\| WARM_UP_RATE \| 400 \| refine-from \|/);
  const own = sink();
  await main(
    [
      'local',
      'stub',
      'breakpoint',
      '--dry-run',
      '--modules-root',
      MODULES_ROOT,
      '--refine-from',
      refine,
      '--set',
      'LEVELS=450,650',
    ],
    { stdout: own },
    { resultsRoot: tempDir() },
  );
  assert.match(own.text, /\| LEVELS \| 450,650 \| cli \|/);
  assert.match(own.text, /\| WARM_UP_RATE \| 400 \| refine-from \|/);
  await assert.rejects(
    main(
      [
        'local',
        'stub',
        'load',
        '--dry-run',
        '--modules-root',
        MODULES_ROOT,
        '--refine-from',
        refine,
      ],
      { stdout: sink() },
      {},
    ),
    /only for breakpoint/,
  );
});

test('refusals: unknown test type, prod, unknown --set, wrong arity', async () => {
  const io = { stdout: sink() };
  await assert.rejects(
    main(['local', 'stub', 'soak', '--dry-run', '--modules-root', MODULES_ROOT], io),
    /has no soak test/,
  );
  await assert.rejects(
    main(['prod', 'stub', 'load', '--dry-run', '--modules-root', MODULES_ROOT], io),
    /prod is always refused/,
  );
  await assert.rejects(
    main(
      ['local', 'stub', 'load', '--dry-run', '--modules-root', MODULES_ROOT, '--set', 'NOPE=1'],
      io,
    ),
    /Unknown setting NOPE/,
  );
  await assert.rejects(main(['local', 'stub'], io), /run needs <env> <subject> <test-type>/);
});
