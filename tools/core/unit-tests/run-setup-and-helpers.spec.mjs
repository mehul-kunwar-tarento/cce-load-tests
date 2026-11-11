/**
 * run-setup-and-helpers.spec.mjs — unit tests of run-setup.mjs, json-file.mjs, format.mjs, results.mjs,
 * inspect-k6.mjs, run-shellcheck.mjs and the CLI dispatcher (tools/cli.mjs).
 *
 * What:    Settings with dataset and plan-definition set (dataset defaults filled, STEP_SLA_PEAK_ALARM_RATE
 *          from the set; an unknown EVENT_ACTION_ID refused), run-context.json fields (no database, no $comment), "$comment" dropped by the JSON
 *          loader, number/time formatting, results folders, the k6 inspect command (--network none), ShellCheck
 *          runner choice, and the CLI listing A3's commands and explaining a missing command file.
 * How:     node --test tools/core/unit-tests/run-setup-and-helpers.spec.mjs
 * Needs:   config/, test-data/, the stub module fixture.
 * Outputs: Test results only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { COMMANDS, runCli } from '../../cli.mjs';
import {
  formatClock,
  formatNumber,
  formatPercent,
  formatSeconds,
  markdownTable,
  toIsoWithOffset,
} from '../format.mjs';
import { buildInspectArgs, findTestScripts, inspectAll } from '../inspect-k6.mjs';
import { readConfigJson } from '../json-file.mjs';
import { RefusedError } from '../errors.mjs';
import { REPO_ROOT } from '../paths.mjs';
import {
  createResultsDir,
  findResultDirs,
  parseResultDirName,
  writeGeneratedJson,
  readJson,
} from '../results.mjs';
import { buildRunContext, prepareRunSettings } from '../run-setup.mjs';
import { buildShellcheckCommand, chooseRunner } from '../run-shellcheck.mjs';
import { getServiceModule } from '../service-registry.mjs';
import { localEnvironment, sink, tempDir } from './helpers.mjs';

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;

test('prepareRunSettings: dataset defaults filled (derived), set loaded, run context built', async () => {
  const environment = localEnvironment();
  const module = await getServiceModule('stub', { root: FIXTURES });
  const setup = await prepareRunSettings({
    environment,
    module,
    testType: 'load',
    overrides: { LOAD_EVENTS: '1000' },
    env: {},
    now: new Date('2026-11-05T14:22:33'),
  });
  const { values, sources } = setup.resolved;
  assert.equal(values.LOAD_DURATION, 20);
  assert.equal(values.EVENT_ACTION_ID, 'visit-encounter');
  assert.equal(sources.EVENT_SOURCE, 'derived');
  assert.equal(values.FACILITY_ID, 'LOADTEST-FACILITY-01');
  assert.equal(setup.dataset.name, 'ebuzima-emr');
  if (setup.planDefinitionSet?.planDefinitions?.length) {
    // A3's sets are present: the single set gives 1 DUE alarm per event → 50 alarms/s at peak.
    assert.equal(values.STEP_SLA_PEAK_ALARM_RATE, 50);
  }
  const context = buildRunContext({
    setup,
    module,
    testType: 'load',
    environment,
    apiPort: 6565,
    startedAt: new Date('2026-11-05T14:22:33'),
    resultsDir: {
      relativeDir: 'results/stub-load-20261105-142233',
      dirInContainer: '/tests/results/stub-load-20261105-142233',
    },
  });
  assert.equal(context.schemaVersion, '1.0.0');
  assert.equal(context.runId, '20261105-142233');
  assert.equal(context.idCode, 'stb');
  assert.ok(!('database' in context.environment));
  assert.ok(!('$comment' in context.dataset));
  assert.ok(!('$comment' in context.settings));
  assert.equal(context.phasePlan.plannedMeasuredEvents, 1000);
  assert.deepEqual(context.k6, { apiPort: 6565 });
  assert.equal(context.planDefinitionSet.name, 'emr-service');
});

test('prepareRunSettings refuses an EVENT_ACTION_ID the dataset has no template for (before any run)', async () => {
  const module = await getServiceModule('stub', { root: FIXTURES });
  await assert.rejects(
    prepareRunSettings({
      environment: localEnvironment(),
      module,
      testType: 'load',
      overrides: { EVENT_ACTION_ID: 'nope' },
      env: {},
    }),
    (error) =>
      error instanceof RefusedError &&
      /EVENT_ACTION_ID "nope" has no event template in dataset ebuzima-emr: use one of visit-encounter, /.test(
        error.message,
      ),
  );
  // A known one is accepted.
  const ok = await prepareRunSettings({
    environment: localEnvironment(),
    module,
    testType: 'load',
    overrides: { EVENT_ACTION_ID: 'lab-order' },
    env: {},
  });
  assert.equal(ok.resolved.values.EVENT_ACTION_ID, 'lab-order');
});

test('readConfigJson drops the top-level $comment only', () => {
  const file = path.join(tempDir(), 'x.json');
  fs.writeFileSync(file, JSON.stringify({ $comment: 'h', a: { $comment: 'nested stays' } }));
  assert.deepEqual(readConfigJson(file), { a: { $comment: 'nested stays' } });
});

test('formatting: separators, percentages, durations, clock, ISO with offset, tables', () => {
  assert.equal(formatNumber(28810), '28,810');
  assert.equal(formatNumber(null), 'n/a');
  assert.equal(formatPercent(0.0000166), '0.002%');
  assert.equal(formatSeconds(600), '10m 0s');
  assert.equal(formatSeconds(0.2), '200ms');
  assert.equal(formatSeconds(742.1), '12m 22.1s');
  assert.match(
    toIsoWithOffset(new Date()),
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/,
  );
  assert.equal(formatClock(toIsoWithOffset(new Date(2026, 10, 5, 14, 31, 2))), '14:31:02');
  assert.equal(markdownTable(['a', 'b'], [['x|y', 1]]), '| a | b |\n|---|---|\n| x\\|y | 1 |');
});

test('results: folder naming, no clobbering, only folders with result.json are found', () => {
  const root = tempDir();
  const startedAt = new Date(2026, 10, 5, 14, 22, 33);
  const { dir, relativeDir, dirInContainer } = createResultsDir({
    subject: 'matcher',
    testType: 'stress',
    startedAt,
    root,
    repoRoot: path.dirname(root),
  });
  assert.equal(path.basename(dir), 'matcher-stress-20261105-142233');
  assert.equal(dirInContainer, `/tests/${relativeDir}`);
  assert.throws(
    () => createResultsDir({ subject: 'matcher', testType: 'stress', startedAt, root }),
    /EEXIST/,
  );
  writeGeneratedJson(path.join(dir, 'result.json'), 'What: x How: y Needs: z Outputs: w', { a: 1 });
  assert.deepEqual(
    readJson(path.join(dir, 'result.json')),
    { a: 1 },
    'generated $comment dropped on load',
  );
  fs.mkdirSync(path.join(root, 'collector-load-1103003810'));
  assert.deepEqual(findResultDirs({ root }), [dir]);
  assert.deepEqual(findResultDirs({ root, since: '2026-11-06' }), []);
  assert.deepEqual(parseResultDirName('step-sla-breakpoint-20261105-160000'), {
    subject: 'step-sla',
    testType: 'breakpoint',
    stamp: '20261105-160000',
  });
});

test('inspect-k6: --network none, RUN_CONTEXT through k6 -e, fixtures never scanned', () => {
  const args = buildInspectArgs({
    repoRoot: '/repo',
    image: 'img',
    runContextInContainer: '/tests/.cache/inspect/x.json',
    scriptInContainer: '/tests/a/x-load.test.js',
    uid: 1,
    gid: 2,
  });
  assert.deepEqual(args.slice(0, 4), ['run', '--rm', '--network', 'none']);
  assert.deepEqual(args.slice(args.indexOf('inspect')), [
    'inspect',
    '-e',
    'RUN_CONTEXT=/tests/.cache/inspect/x.json',
    '/tests/a/x-load.test.js',
  ]);
  assert.ok(!findTestScripts(REPO_ROOT).some((file) => file.includes('/fixtures/')));
});

test('inspect-k6 --dry-run prints the docker command and writes no run context', async () => {
  const repoRoot = tempDir();
  const script = path.join(repoRoot, 'cce-collector-service', 'tests', 'collector-load.test.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, '// placeholder: never run\n');
  const out = sink();
  const code = await inspectAll({
    files: [script],
    dryRun: true,
    repoRoot,
    modulesRoot: REPO_ROOT,
    out,
    run: () => assert.fail('a dry run never starts docker'),
  });
  assert.equal(code, 0);
  assert.match(out.text, /^docker run --rm --network none .* inspect -e RUN_CONTEXT=/);
  assert.equal(fs.existsSync(path.join(repoRoot, '.cache')), false);
});

test('run-shellcheck: local binary first, then a local image, else skipped; image runs without network', () => {
  const run = (has) => (cmd) => ({ status: has.includes(cmd) ? 0 : 1 });
  assert.equal(chooseRunner({ run: run(['shellcheck', 'docker']) }), 'local');
  assert.equal(chooseRunner({ run: run(['docker']) }), 'docker');
  assert.equal(chooseRunner({ run: run([]) }), null);
  const { command, args } = buildShellcheckCommand('docker', ['scripts/a.sh'], '/repo');
  assert.equal(command, 'docker');
  assert.ok(
    args.includes('none') &&
      args.includes('koalaman/shellcheck:v0.10.0') &&
      args.at(-1) === 'scripts/a.sh',
  );
});

test('cli: --help lists A2 and A3 commands; unknown command → 2; a missing command file is explained', async () => {
  assert.deepEqual(Object.keys(COMMANDS).sort(), [
    'baseline',
    'check-data',
    'cleanup',
    'lint-headers',
    'plan-definitions',
    'preflight',
    'report',
    'run',
    'settings',
  ]);
  const out = sink();
  assert.equal(await runCli(['--help'], { stdout: out }), 0);
  for (const name of Object.keys(COMMANDS)) assert.match(out.text, new RegExp(`\\n  ${name} `));
  const err = sink();
  assert.equal(await runCli(['nonsense'], { stdout: sink(), stderr: err }), 2);
  assert.match(err.text, /Unknown command "nonsense"/);
  const missing = Object.entries(COMMANDS).find(
    ([, file]) => !fs.existsSync(path.join(REPO_ROOT, 'tools', 'commands', file)),
  );
  if (missing) {
    const err2 = sink();
    assert.equal(await runCli([missing[0], 'x'], { stdout: sink(), stderr: err2 }), 3);
    assert.match(err2.text, /is not installed/);
  }
});

test('cli maps errors to exit codes: refused (prod) → 2, bad option → 2 with usage', async () => {
  const err = sink();
  assert.equal(await runCli(['settings', 'prod'], { stdout: sink(), stderr: err }), 2);
  assert.match(err.text, /prod is always refused/);
  const err2 = sink();
  assert.equal(
    await runCli(['settings', 'local', '--sett', 'X=1'], { stdout: sink(), stderr: err2 }),
    2,
  );
  assert.match(err2.text, /Usage: settings/);
});
